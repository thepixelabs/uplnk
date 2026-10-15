/**
 * McpManager auto-reconnect tests (E.3.3).
 *
 * Built-in MCP child processes can crash for mundane reasons (OOM, SIGPIPE,
 * a broken update). When a child dies the SDK fires transport.onerror and
 * transport.onclose; previously McpManager just removed the connection and
 * the LLM permanently lost those tools for the session. E.3.3 adds an
 * exponential-backoff auto-reconnect loop scoped to BUILTIN_SERVER_IDS:
 *
 *     attempt 1 → 500 ms
 *     attempt 2 → 1000 ms
 *     attempt 3 → 2000 ms
 *     attempt 4 → give up, log warning
 *
 * These tests use vi.useFakeTimers() so we can advance the clock to exactly
 * the backoff boundaries and confirm the timer chain. Each transport
 * constructor call returns its own object so we can selectively fire close
 * on a specific connection's transport.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── SDK mocks ───────────────────────────────────────────────────────────────

interface FakeTransport {
  onclose: (() => void) | undefined;
  onerror: ((err: Error) => void) | undefined;
  _opts: unknown;
}

const transportInstances: FakeTransport[] = [];

// connect() and listTools() are configured per-test via these queues / fns.
let connectImpl: () => Promise<void> = () => Promise.resolve();
let listToolsImpl: () => Promise<{ tools: { name: string; description: string; inputSchema: object }[] }> = () =>
  Promise.resolve({ tools: [] });

const mockConnect = vi.fn(() => connectImpl());
const mockClose = vi.fn(() => Promise.resolve());
const mockListTools = vi.fn(() => listToolsImpl());
const mockCallTool = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: vi.fn().mockImplementation(() => ({
      connect: mockConnect,
      close: mockClose,
      listTools: mockListTools,
      callTool: mockCallTool,
    })),
  };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: vi.fn().mockImplementation((opts: unknown) => {
      // Each connect() builds a brand-new transport; we hand back a fresh
      // object so the test can target an exact incarnation when firing close.
      const t: FakeTransport = {
        onclose: undefined,
        onerror: undefined,
        _opts: opts,
      };
      transportInstances.push(t);
      return t;
    }),
  };
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  return {
    StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({})),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: vi.fn(() => {
      throw new Error('ENOENT');
    }),
    realpathSync: (p: string) => p,
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

// ─── Subject under test ───────────────────────────────────────────────────────

import {
  McpManager,
  BUILTIN_FILE_BROWSE_ID,
  type McpServerConfig,
} from '../McpManager.js';
import { createDefaultPolicy } from '../security.js';

const ALLOWED_ROOT = '/projects/myapp';

function makeManager() {
  return new McpManager({
    filePolicy: createDefaultPolicy([ALLOWED_ROOT]),
    commandExecEnabled: false,
    gitEnabled: false,
    ragEnabled: false,
    requestApproval: vi.fn().mockResolvedValue(true),
  });
}

const BUILTIN_CFG: McpServerConfig = {
  id: BUILTIN_FILE_BROWSE_ID,
  name: 'uplnk-file-browse',
  command: '/usr/bin/bun',
  args: ['/fake/path/file-browse.ts'],
};

const EXTERNAL_CFG: McpServerConfig = {
  id: 'user-defined-server',
  name: 'user-defined-server',
  command: '/usr/bin/external',
  args: [],
};

// Suppress stderr noise from "gave up" / "reconnected" log lines. The
// MockInstance type for process.stderr.write involves overloads vitest
// can't infer cleanly, so we keep the spy untyped via an indirection.
const stderrCalls: unknown[][] = [];
let stderrRestore: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  transportInstances.length = 0;
  connectImpl = () => Promise.resolve();
  listToolsImpl = () => Promise.resolve({ tools: [] });
  mockConnect.mockClear();
  mockClose.mockClear();
  mockListTools.mockClear();
  mockCallTool.mockClear();
  stderrCalls.length = 0;
  const original = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (...args: unknown[]) => {
    stderrCalls.push(args);
    return true;
  };
  stderrRestore = () => {
    process.stderr.write = original as typeof process.stderr.write;
  };
});

afterEach(() => {
  stderrRestore?.();
  vi.useRealTimers();
});

/**
 * Convenience: drive the event loop one microtask tick at a time so awaited
 * promises inside timer callbacks resolve before we assert. vi.advanceTimers
 * + a Promise.resolve flush is the canonical recipe for fake-timer + async.
 */
async function flushMicrotasks(): Promise<void> {
  // A few rounds covers chained then-callbacks inside _fireReconnect.
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

describe('McpManager auto-reconnect (E.3.3)', () => {
  it('schedules a reconnect 500 ms after a built-in close', async () => {
    const mgr = makeManager();
    await mgr.connect(BUILTIN_CFG);
    expect(mockConnect).toHaveBeenCalledTimes(1);

    // Fire close on the live transport — simulates the child crashing.
    transportInstances[0]!.onclose!();
    expect(mgr.isConnected(BUILTIN_FILE_BROWSE_ID)).toBe(false);

    // Just before the boundary: no reconnect yet.
    await vi.advanceTimersByTimeAsync(499);
    expect(mockConnect).toHaveBeenCalledTimes(1);

    // At 500 ms exactly: the retry attempt runs.
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it('resets the attempts counter on a successful reconnect', async () => {
    const mgr = makeManager();
    await mgr.connect(BUILTIN_CFG);

    // Crash → reconnect succeeds.
    transportInstances[0]!.onclose!();
    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();
    expect(mgr.isConnected(BUILTIN_FILE_BROWSE_ID)).toBe(true);

    // Crash a second time — should retry at 500 ms (not 1 s).
    const liveTransport = transportInstances[transportInstances.length - 1]!;
    liveTransport.onclose!();
    await vi.advanceTimersByTimeAsync(499);
    expect(mockConnect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(mockConnect).toHaveBeenCalledTimes(3);
  });

  it('walks 500/1000/2000 ms backoff over three failures then gives up', async () => {
    const mgr = makeManager();
    await mgr.connect(BUILTIN_CFG);
    expect(mockConnect).toHaveBeenCalledTimes(1);

    // Every subsequent connect attempt rejects, simulating a wedged binary.
    connectImpl = () => Promise.reject(new Error('child wont spawn'));

    // Crash.
    transportInstances[0]!.onclose!();

    // Attempt 1 at 500 ms — fails.
    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();
    expect(mockConnect).toHaveBeenCalledTimes(2);

    // Attempt 2 at +1000 ms — fails.
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(mockConnect).toHaveBeenCalledTimes(3);

    // Attempt 3 at +2000 ms — fails.
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(mockConnect).toHaveBeenCalledTimes(4);

    // Attempt 4 must NOT be scheduled — even if we wait a full minute.
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(mockConnect).toHaveBeenCalledTimes(4);

    // A warning was written to stderr.
    const warnCalls = stderrCalls.filter((c) =>
      String(c[0]).includes('gave up auto-reconnecting'),
    );
    expect(warnCalls.length).toBe(1);
  });

  it('does NOT auto-reconnect external (non-builtin) servers', async () => {
    const mgr = makeManager();
    await mgr.connect(EXTERNAL_CFG);
    expect(mockConnect).toHaveBeenCalledTimes(1);

    transportInstances[0]!.onclose!();
    // No timer should be pending; advance well past 500 ms.
    await vi.advanceTimersByTimeAsync(5000);
    await flushMicrotasks();
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('destroy() during a pending reconnect cancels the timer', async () => {
    const mgr = makeManager();
    await mgr.connect(BUILTIN_CFG);

    transportInstances[0]!.onclose!();
    // Reconnect armed but not yet fired.
    await vi.advanceTimersByTimeAsync(100);
    expect(mockConnect).toHaveBeenCalledTimes(1);

    await mgr.destroy();
    // Advance past when the timer would have fired.
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('an explicit disconnect() cancels the reconnect state', async () => {
    const mgr = makeManager();
    await mgr.connect(BUILTIN_CFG);

    // disconnect() actively closes the transport — emulate the SDK firing
    // onclose synchronously from inside close() to model a real teardown.
    mockClose.mockImplementationOnce(() => {
      transportInstances[0]!.onclose!();
      return Promise.resolve();
    });

    await mgr.disconnect(BUILTIN_FILE_BROWSE_ID);

    // No reconnect should ever fire.
    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('keeps backoff progressing if the reconnected child crashes immediately', async () => {
    const mgr = makeManager();
    await mgr.connect(BUILTIN_CFG);

    // First failure → schedule.
    transportInstances[0]!.onclose!();

    // Reconnect succeeds, but the new child dies immediately at every retry.
    // We don't set connectImpl to reject — we let connect succeed, then
    // synchronously fire onclose on the freshly-built transport to simulate
    // the SDK observing a fast crash. The state's attempts counter resets
    // on successful connect, so this exercises the "fresh start" path.
    let cycle = 0;
    const origConnect = connectImpl;
    connectImpl = () => {
      return origConnect().then(() => {
        cycle++;
        if (cycle <= 2) {
          // Defer to the next microtask so connect() completes first.
          queueMicrotask(() => {
            const fresh = transportInstances[transportInstances.length - 1]!;
            fresh.onclose?.();
          });
        }
      });
    };

    // First retry at 500 ms — succeeds but crashes again.
    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();
    expect(mockConnect).toHaveBeenCalledTimes(2);

    // Because attempts reset on success, the next retry is again 500 ms.
    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();
    expect(mockConnect).toHaveBeenCalledTimes(3);

    // Third reconnect succeeds and stays up (cycle > 2).
    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();
    expect(mockConnect).toHaveBeenCalledTimes(4);
    expect(mgr.isConnected(BUILTIN_FILE_BROWSE_ID)).toBe(true);
  });

  it('dedupes onerror+onclose pair into a single reconnect', async () => {
    const mgr = makeManager();
    await mgr.connect(BUILTIN_CFG);

    // SDK convention: a dying transport emits onerror THEN onclose. We must
    // only schedule one retry — otherwise we'd fire the reconnect twice on
    // the same boundary.
    transportInstances[0]!.onerror!(new Error('broken pipe'));
    transportInstances[0]!.onclose!();

    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();
    expect(mockConnect).toHaveBeenCalledTimes(2);

    // And no second retry fires off another 500 ms later.
    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it('calls listTools once after a successful reconnect', async () => {
    const mgr = makeManager();
    listToolsImpl = () => Promise.resolve({
      tools: [
        {
          name: 'mcp_file_read',
          description: 'read',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
      ],
    });
    await mgr.connect(BUILTIN_CFG);

    transportInstances[0]!.onclose!();
    expect(mockListTools).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockListTools).toHaveBeenCalledTimes(1);
  });

  it('a subsequent connect() resets attempts after the manager has given up', async () => {
    const mgr = makeManager();
    await mgr.connect(BUILTIN_CFG);

    // Burn through all 3 retries.
    connectImpl = () => Promise.reject(new Error('broken'));
    transportInstances[0]!.onclose!();
    await vi.advanceTimersByTimeAsync(500); await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000); await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000); await flushMicrotasks();
    expect(mockConnect).toHaveBeenCalledTimes(4);

    // No further retry pending.
    await vi.advanceTimersByTimeAsync(60_000); await flushMicrotasks();
    expect(mockConnect).toHaveBeenCalledTimes(4);

    // App-level recovery: caller invokes connect() directly.
    connectImpl = () => Promise.resolve();
    await mgr.connect(BUILTIN_CFG);
    expect(mockConnect).toHaveBeenCalledTimes(5);
    expect(mgr.isConnected(BUILTIN_FILE_BROWSE_ID)).toBe(true);

    // Crash again — backoff must restart at 500 ms, not stay at give-up.
    const live = transportInstances[transportInstances.length - 1]!;
    live.onclose!();
    await vi.advanceTimersByTimeAsync(500); await flushMicrotasks();
    expect(mockConnect).toHaveBeenCalledTimes(6);
  });

  it('does not schedule a reconnect when destroy fires before a close', async () => {
    const mgr = makeManager();
    await mgr.connect(BUILTIN_CFG);

    // destroy() will call disconnect() which (via mockClose) is a no-op here
    // — the SDK doesn't fire onclose. We then fire onclose manually to model
    // a stray late event from the OS pipe close.
    await mgr.destroy();
    transportInstances[0]!.onclose!();

    await vi.advanceTimersByTimeAsync(5000); await flushMicrotasks();
    // The only connect call is the initial one — destroy short-circuited
    // the reconnect path.
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('a pending reconnect listTools failure does not double-schedule', async () => {
    const mgr = makeManager();
    await mgr.connect(BUILTIN_CFG);

    // After reconnect, listTools throws — this should NOT trigger an extra
    // immediate _scheduleReconnect. (The next real transport close would.)
    listToolsImpl = () => Promise.reject(new Error('child wedged'));

    transportInstances[0]!.onclose!();
    await vi.advanceTimersByTimeAsync(500); await flushMicrotasks();
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockListTools).toHaveBeenCalledTimes(1);

    // Advance a long way — nothing further fires because we don't react to
    // listTools failure with another timer.
    await vi.advanceTimersByTimeAsync(10_000); await flushMicrotasks();
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it('does not auto-reconnect when destroyed manager receives a late close', async () => {
    const mgr = makeManager();
    await mgr.connect(BUILTIN_CFG);

    // Destroy first, then have the OS fire a stale close event.
    await mgr.destroy();
    expect(() => transportInstances[0]!.onclose!()).not.toThrow();

    await vi.advanceTimersByTimeAsync(5000); await flushMicrotasks();
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });
});
