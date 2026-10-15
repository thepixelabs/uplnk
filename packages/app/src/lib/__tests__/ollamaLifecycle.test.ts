import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────
//
// Mock child_process so spawn/execFile are observable from tests without
// actually creating processes. fs.existsSync is per-test so we can drive the
// fallback-path probing matrix.

const cp = vi.hoisted(() => {
  const spawn = vi.fn();
  const execFile = vi.fn();
  return { spawn, execFile };
});

vi.mock('node:child_process', () => ({
  spawn: cp.spawn,
  execFile: cp.execFile,
}));

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn<(p: string) => boolean>(),
}));
vi.mock('node:fs', () => ({
  existsSync: fsMocks.existsSync,
}));

import {
  probeOllama,
  launchOllama,
  fallbackPathsForPlatform,
} from '../ollamaLifecycle.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockFetch(impl: (...args: Parameters<typeof fetch>) => Promise<Response>): void {
  globalThis.fetch = vi.fn(impl) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Causes `execFile('which', ['ollama'], ...)` to error out → simulates a
 * machine where the PATH lookup fails. */
function whichFails(): void {
  cp.execFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
      const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
      callback(new Error('not found'), '', '');
      return { kill: vi.fn() } as unknown as ReturnType<typeof cp.execFile>;
    },
  );
}

/** Causes `which`/`where` to resolve with the given absolute path. */
function whichReturns(path: string): void {
  cp.execFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
      const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
      callback(null, `${path}\n`, '');
      return { kill: vi.fn() } as unknown as ReturnType<typeof cp.execFile>;
    },
  );
}

function makeSpawnedChild(pid = 4242): { pid: number; unref: () => void } {
  return { pid, unref: vi.fn() };
}

beforeEach(() => {
  cp.spawn.mockReset();
  cp.execFile.mockReset();
  fsMocks.existsSync.mockReset();
  fsMocks.existsSync.mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── probeOllama ──────────────────────────────────────────────────────────────

describe('probeOllama', () => {
  it('returns reachable + validResponse on 200 with models array', async () => {
    mockFetch(async () => jsonResponse({ models: [{ name: 'llama3' }] }));
    const result = await probeOllama('http://localhost:11434');
    expect(result.reachable).toBe(true);
    expect(result.validResponse).toBe(true);
    expect(typeof result.latencyMs).toBe('number');
  });

  it('returns unreachable on fetch rejection (treated as timeout)', async () => {
    mockFetch(async () => {
      throw Object.assign(new Error('abort'), { name: 'AbortError' });
    });
    const result = await probeOllama('http://localhost:11434', undefined, 1);
    expect(result.reachable).toBe(false);
    expect(result.validResponse).toBe(false);
  });

  it('marks a 500 as reachable but not a valid response', async () => {
    mockFetch(async () => new Response('boom', { status: 500 }));
    const result = await probeOllama('http://localhost:11434');
    expect(result.reachable).toBe(true);
    expect(result.validResponse).toBe(false);
  });
});

// ─── launchOllama ─────────────────────────────────────────────────────────────

describe('launchOllama', () => {
  it("returns 'already-running' when the first probe succeeds", async () => {
    mockFetch(async () => jsonResponse({ models: [] }));
    const out = await launchOllama({ url: 'http://localhost:11434' });
    expect(out).toEqual({ status: 'already-running' });
    expect(cp.spawn).not.toHaveBeenCalled();
  });

  it("returns 'not-installed' when `which` fails and no fallback paths exist", async () => {
    mockFetch(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    whichFails();
    fsMocks.existsSync.mockReturnValue(false);
    const out = await launchOllama({ url: 'http://localhost:11434' });
    expect(out).toEqual({ status: 'not-installed' });
    expect(cp.spawn).not.toHaveBeenCalled();
  });

  it("returns 'started' once the daemon becomes reachable during the readiness wait", async () => {
    let probeCalls = 0;
    mockFetch(async () => {
      probeCalls += 1;
      // Calls: 1 initial fail (triggers spawn), 2 fail, 3 succeed.
      if (probeCalls < 3) throw new Error('connect ECONNREFUSED');
      return jsonResponse({ models: [{ name: 'llama3' }] });
    });
    whichReturns('/usr/local/bin/ollama');
    fsMocks.existsSync.mockReturnValue(true);
    cp.spawn.mockReturnValue(makeSpawnedChild(9001));

    const out = await launchOllama({
      url: 'http://localhost:11434',
      readinessTimeoutMs: 5_000,
      pollIntervalMs: 5,
    });
    expect(out.status).toBe('started');
    if (out.status === 'started') {
      expect(out.pid).toBe(9001);
      expect(out.reachableAfterMs).toBeGreaterThanOrEqual(0);
    }
    expect(cp.spawn).toHaveBeenCalledTimes(1);
    expect(cp.spawn).toHaveBeenCalledWith(
      '/usr/local/bin/ollama',
      ['serve'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
  });

  it("returns 'unreachable-after-launch' when readiness timeout expires", async () => {
    mockFetch(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    whichReturns('/usr/local/bin/ollama');
    fsMocks.existsSync.mockReturnValue(true);
    cp.spawn.mockReturnValue(makeSpawnedChild(4321));

    const out = await launchOllama({
      url: 'http://localhost:11434',
      readinessTimeoutMs: 50,
      pollIntervalMs: 10,
    });
    expect(out).toEqual({ status: 'unreachable-after-launch', pid: 4321 });
  });

  it("returns 'launch-failed' when spawn throws synchronously", async () => {
    mockFetch(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    whichReturns('/usr/local/bin/ollama');
    fsMocks.existsSync.mockReturnValue(true);
    cp.spawn.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const out = await launchOllama({ url: 'http://localhost:11434' });
    expect(out.status).toBe('launch-failed');
    if (out.status === 'launch-failed') {
      expect(out.error).toContain('EACCES');
    }
  });

  it("returns 'launch-failed' when spawn returns a child without a pid", async () => {
    mockFetch(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    whichReturns('/usr/local/bin/ollama');
    fsMocks.existsSync.mockReturnValue(true);
    cp.spawn.mockReturnValue({ pid: undefined, unref: vi.fn() });

    const out = await launchOllama({ url: 'http://localhost:11434' });
    expect(out.status).toBe('launch-failed');
  });

  it('throws AbortError when the caller aborts during the readiness wait', async () => {
    mockFetch(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    whichReturns('/usr/local/bin/ollama');
    fsMocks.existsSync.mockReturnValue(true);
    cp.spawn.mockReturnValue(makeSpawnedChild(7777));

    const controller = new AbortController();
    // Abort shortly into the readiness wait.
    setTimeout(() => controller.abort(), 30);

    await expect(
      launchOllama({
        url: 'http://localhost:11434',
        readinessTimeoutMs: 5_000,
        pollIntervalMs: 20,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});

// ─── fallbackPathsForPlatform ────────────────────────────────────────────────

describe('fallbackPathsForPlatform', () => {
  it("checks macOS Homebrew + Ollama.app locations on 'darwin'", () => {
    const paths = fallbackPathsForPlatform('darwin');
    expect(paths).toContain('/usr/local/bin/ollama');
    expect(paths).toContain('/opt/homebrew/bin/ollama');
    expect(paths.some((p) => p.endsWith('Ollama.app/Contents/Resources/ollama'))).toBe(true);
  });

  it("checks standard package-manager paths on 'linux'", () => {
    const paths = fallbackPathsForPlatform('linux');
    expect(paths).toEqual(['/usr/local/bin/ollama', '/usr/bin/ollama']);
  });

  it("checks Program Files + LOCALAPPDATA on 'win32'", () => {
    const prev = process.env['LOCALAPPDATA'];
    process.env['LOCALAPPDATA'] = 'C:\\Users\\alice\\AppData\\Local';
    try {
      const paths = fallbackPathsForPlatform('win32');
      expect(paths[0]).toBe('C:\\Program Files\\Ollama\\ollama.exe');
      expect(paths.some((p) => p.includes('alice') && p.endsWith('ollama.exe'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['LOCALAPPDATA'];
      else process.env['LOCALAPPDATA'] = prev;
    }
  });
});
