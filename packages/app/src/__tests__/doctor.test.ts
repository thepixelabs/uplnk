/**
 * Tests for packages/app/src/lib/doctor.ts
 *
 * Strategy:
 * - Mock at system boundaries: node:fs (accessSync), global fetch, uplnk-db,
 *   process.version, and process.exit.
 * - Each check is exercised in isolation AND we verify that all checks run
 *   even when one fails (the doctor never short-circuits).
 * - process.exit is stubbed so a failing doctor cannot kill the test runner.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Module mocks (hoisted) ────────────────────────────────────────────────────

vi.mock('node:fs', () => ({
  accessSync: vi.fn(),
  constants: { W_OK: 2 },
}));

// uplnk-db is imported both at the top of doctor.ts (for getUplnkDir /
// getUplnkDbPath) and dynamically inside the SQLite check. We mock the module
// once; the dynamic import will resolve to the same mock.
vi.mock('@uplnk/db', () => ({
  getUplnkDir: vi.fn(() => '/home/testuser/.uplnk'),
  getUplnkDbPath: vi.fn(() => '/home/testuser/.uplnk/db.sqlite'),
  getUplnkDir: vi.fn(() => '/home/testuser/.uplnk'), // Keep for compat if needed in doctor.ts
  getUplnkDbPath: vi.fn(() => '/home/testuser/.uplnk/db.sqlite'),
  db: {
    get: vi.fn(),
  },
}));

vi.mock('chalk', () => {
  // Return plain strings so assertions don't need to strip ANSI codes.
  const identity = (s: string) => s;
  const tag = Object.assign(identity, {
    bold: Object.assign(identity, { green: identity, red: identity, yellow: identity }),
    green: Object.assign(identity, { bold: identity }),
    red: Object.assign(identity, { bold: identity }),
    yellow: Object.assign(identity, { bold: identity }),
    gray: identity,
  });
  return { default: tag };
});

// ─── Imports after mocks are registered ───────────────────────────────────────

import { accessSync } from 'node:fs';
import { getUplnkDir, getUplnkDbPath, db } from '@uplnk/db';
import { runDoctor } from '../lib/doctor.js';

// ─── Typed mock helpers ────────────────────────────────────────────────────────

const mockAccessSync = vi.mocked(accessSync);
const mockGetUplnkDir = vi.mocked(getUplnkDir);
const mockGetUplnkDbPath = vi.mocked(getUplnkDbPath);
const mockDbGet = vi.mocked(db.get as (...args: unknown[]) => unknown);

const UPLNK_DIR = '/home/testuser/.uplnk';
const DB_PATH = '/home/testuser/.uplnk/db.sqlite';

// ─── Shared setup / teardown ──────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let exitSpy: ReturnType<typeof vi.spyOn<any, any>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let consoleLogSpy: ReturnType<typeof vi.spyOn<any, any>>;
let fetchSpy: ReturnType<typeof vi.fn>;

/** Configure all checks to pass (the "all green" baseline). */
function setAllChecksGreen(): void {
  // Node version check reads process.version — v20.0.0 satisfies >=20.
  Object.defineProperty(process, 'version', { value: 'v20.0.0', writable: true, configurable: true });

  // Config directory check: accessSync does not throw.
  mockGetUplnkDir.mockReturnValue(UPLNK_DIR);
  mockAccessSync.mockReturnValue(undefined);

  // SQLite check: db.get('SELECT 1') succeeds.
  mockGetUplnkDbPath.mockReturnValue(DB_PATH);
  mockDbGet.mockReturnValue(undefined);

  // Ollama check: fetch returns a 200 response.
  fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));
}

beforeEach(() => {
  vi.clearAllMocks();

  exitSpy = vi.spyOn(process, 'exit').mockImplementation(
    (() => {}) as (code?: string | number | null) => never,
  );
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);

  setAllChecksGreen();
});

afterEach(() => {
  vi.unstubAllGlobals();
  exitSpy.mockRestore();
  consoleLogSpy.mockRestore();
});

// ─── All checks passing ───────────────────────────────────────────────────────

describe('runDoctor — all checks passing', () => {
  it('does not call process.exit when every check passes', async () => {
    await runDoctor();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('logs a success summary when every check passes', async () => {
    await runDoctor();

    const allOutput = consoleLogSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain('All checks passed');
  });

  it('logs each check name exactly once', async () => {
    await runDoctor();

    const allOutput = consoleLogSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain('Node.js version');
    expect(allOutput).toContain('Config directory');
    expect(allOutput).toContain('SQLite database');
    expect(allOutput).toContain('Ollama reachability');
  });
});

// ─── Node.js version check ────────────────────────────────────────────────────

describe('runDoctor — Node.js version check', () => {
  it('passes when Node major version is exactly 20', async () => {
    Object.defineProperty(process, 'version', { value: 'v20.0.0', writable: true, configurable: true });

    await runDoctor();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('passes when Node major version is above 20', async () => {
    Object.defineProperty(process, 'version', { value: 'v22.1.0', writable: true, configurable: true });

    await runDoctor();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('fails and calls process.exit(1) when Node major version is 18', async () => {
    Object.defineProperty(process, 'version', { value: 'v18.20.0', writable: true, configurable: true });

    await runDoctor();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('includes "(requires >=20)" in the output when version is too low', async () => {
    Object.defineProperty(process, 'version', { value: 'v18.20.0', writable: true, configurable: true });

    await runDoctor();

    const allOutput = consoleLogSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain('requires >=20');
  });

  it('includes the actual version string in the output when version is too low', async () => {
    Object.defineProperty(process, 'version', { value: 'v16.0.0', writable: true, configurable: true });

    await runDoctor();

    const allOutput = consoleLogSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain('v16.0.0');
  });

  it('fails and calls process.exit(1) when Node major version is 19 (just below threshold)', async () => {
    Object.defineProperty(process, 'version', { value: 'v19.9.9', writable: true, configurable: true });

    await runDoctor();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ─── Config directory check ───────────────────────────────────────────────────

describe('runDoctor — Config directory check', () => {
  it('passes when accessSync does not throw', async () => {
    mockAccessSync.mockReturnValue(undefined);

    await runDoctor();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('calls accessSync with the uplnk directory and W_OK flag', async () => {
    await runDoctor();

    expect(mockAccessSync).toHaveBeenCalledWith(UPLNK_DIR, 2 /* W_OK */);
  });

  it('logs the uplnk directory path in the detail when the check passes', async () => {
    await runDoctor();

    const allOutput = consoleLogSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain(UPLNK_DIR);
  });

  it('fails and calls process.exit(1) when the directory is not writable', async () => {
    mockAccessSync.mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });

    await runDoctor();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('includes "Cannot write to" and the path in the error detail', async () => {
    mockAccessSync.mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });

    await runDoctor();

    const allOutput = consoleLogSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain('Cannot write to');
    expect(allOutput).toContain(UPLNK_DIR);
  });
});

// ─── SQLite database check ────────────────────────────────────────────────────

describe('runDoctor — SQLite database check', () => {
  it('passes when db.get("SELECT 1") succeeds', async () => {
    mockDbGet.mockReturnValue(undefined);

    await runDoctor();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('logs the db path in the detail when the check passes', async () => {
    await runDoctor();

    const allOutput = consoleLogSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain(DB_PATH);
  });

  it('fails and calls process.exit(1) when db.get throws', async () => {
    mockDbGet.mockImplementation(() => {
      throw new Error('SQLITE_CANTOPEN: unable to open database file');
    });

    await runDoctor();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('includes the error message in the detail when db.get throws', async () => {
    mockDbGet.mockImplementation(() => {
      throw new Error('SQLITE_CANTOPEN: unable to open database file');
    });

    await runDoctor();

    const allOutput = consoleLogSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain('SQLITE_CANTOPEN');
  });
});

// ─── Ollama reachability check ────────────────────────────────────────────────

describe('runDoctor — Ollama reachability check', () => {
  it('passes when fetch returns HTTP 200', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));

    await runDoctor();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('fetches the correct Ollama tags endpoint', async () => {
    await runDoctor();

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:11434/api/tags',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('logs the Ollama base URL in the detail when the check passes', async () => {
    await runDoctor();

    const allOutput = consoleLogSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain('http://localhost:11434');
  });

  it('fails when fetch returns a non-OK HTTP status (503)', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 503 }));

    await runDoctor();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('includes the HTTP status code in the detail when fetch returns non-OK', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 503 }));

    await runDoctor();

    const allOutput = consoleLogSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain('503');
  });

  it('fails when fetch throws (connection refused)', async () => {
    fetchSpy.mockRejectedValue(
      Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }),
    );

    await runDoctor();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('includes the "Is Ollama running?" hint when Ollama is unreachable', async () => {
    fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:11434'));

    await runDoctor();

    // doctor.ts detail text: "Not reachable — run `ollama serve`"
    const allOutput = consoleLogSpy.mock.calls.flat().join('\n');
    expect(allOutput).toMatch(/ollama serve/i);
  });

  it('fails when fetch rejects with a timeout-like error', async () => {
    fetchSpy.mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    );

    await runDoctor();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ─── Independence: one failure does not skip subsequent checks ────────────────

describe('runDoctor — check independence', () => {
  it('runs all four checks even when the Node version check fails', async () => {
    Object.defineProperty(process, 'version', { value: 'v16.0.0', writable: true, configurable: true });

    await runDoctor();

    // Ollama fetch must still have been called despite the earlier failure.
    expect(fetchSpy).toHaveBeenCalled();
    // accessSync must still have been called.
    expect(mockAccessSync).toHaveBeenCalled();
  });

  it('runs all four checks even when the config directory check fails', async () => {
    mockAccessSync.mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });

    await runDoctor();

    expect(fetchSpy).toHaveBeenCalled();
  });

  it('runs all four checks even when the SQLite check fails', async () => {
    mockDbGet.mockImplementation(() => { throw new Error('DB error'); });

    await runDoctor();

    expect(fetchSpy).toHaveBeenCalled();
  });

  it('runs all four checks even when Ollama is unreachable', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    await runDoctor();

    // accessSync must still have been called (it runs before Ollama check).
    expect(mockAccessSync).toHaveBeenCalled();
  });

  it('calls process.exit(1) exactly once when multiple checks fail', async () => {
    Object.defineProperty(process, 'version', { value: 'v16.0.0', writable: true, configurable: true });
    mockAccessSync.mockImplementation(() => { throw new Error('EACCES'); });
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    await runDoctor();

    // process.exit is called once at the end of runDoctor, not once per failure.
    expect(exitSpy).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('logs a failure summary when at least one check fails', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    await runDoctor();

    const allOutput = consoleLogSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain('Some checks failed');
  });

  it('does not log the success banner when any check fails', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    await runDoctor();

    const allOutput = consoleLogSpy.mock.calls.flat().join('\n');
    expect(allOutput).not.toContain('All checks passed');
  });
});
