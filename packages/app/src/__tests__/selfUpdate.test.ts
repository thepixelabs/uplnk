/**
 * Tests for packages/app/src/lib/selfUpdate.ts
 *
 * Mocks: node:child_process (execFile), node:fs (readFileSync, writeFileSync, mkdirSync)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('node:module', () => ({
  createRequire: () => (path: string) => {
    if (path.includes('package.json')) return { version: '1.2.3' };
    throw new Error('Not found');
  },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { checkForUpdate, performUpdate } from '../lib/selfUpdate.js';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';

// ─── Helpers ──────────────────────────────────────────────────────────────────

type ExecFileMock = ReturnType<typeof vi.fn>;

function mockExecFile(stdout: string): void {
  // execFile uses promisify; mock the callback form
  (childProcess.execFile as unknown as ExecFileMock).mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, result: { stdout: string }) => void) => {
      cb(null, { stdout });
    },
  );
}

function mockExecFileError(msg: string): void {
  (childProcess.execFile as unknown as ExecFileMock).mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
      cb(new Error(msg));
    },
  );
}

function mockCacheFile(cache: { lastChecked: string; latestVersion: string } | null): void {
  if (cache === null) {
    (fs.readFileSync as ExecFileMock).mockImplementation(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
  } else {
    (fs.readFileSync as ExecFileMock).mockReturnValue(JSON.stringify(cache));
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env['UPLNK_NO_UPDATE'];
  delete process.env['CI'];
});

afterEach(() => {
  delete process.env['UPLNK_NO_UPDATE'];
  delete process.env['CI'];
});

describe('checkForUpdate', () => {
  it('returns null when enabled is false', async () => {
    const result = await checkForUpdate({ packageName: 'uplnk', enabled: false });
    expect(result).toBeNull();
  });

  it('returns null when UPLNK_NO_UPDATE=1', async () => {
    process.env['UPLNK_NO_UPDATE'] = '1';
    const result = await checkForUpdate({ packageName: 'uplnk', enabled: true });
    expect(result).toBeNull();
  });

  it('returns null when CI=true', async () => {
    process.env['CI'] = 'true';
    const result = await checkForUpdate({ packageName: 'uplnk', enabled: true });
    expect(result).toBeNull();
  });

  it('uses cache when it is fresh (< 24h)', async () => {
    // Cache written 1 minute ago with version 1.2.3
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    mockCacheFile({ lastChecked: oneMinuteAgo, latestVersion: '1.2.3' });

    const result = await checkForUpdate({ packageName: 'uplnk', enabled: true });

    // execFile should NOT have been called
    expect(childProcess.execFile).not.toHaveBeenCalled();
    // Current version is 1.2.3 (mocked createRequire), latest is also 1.2.3
    expect(result?.updateAvailable).toBe(false);
    expect(result?.currentVersion).toBe('1.2.3');
    expect(result?.latestVersion).toBe('1.2.3');
  });

  it('fetches from npm when cache is stale (> 24h)', async () => {
    // Cache is 25 hours old
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    mockCacheFile({ lastChecked: twentyFiveHoursAgo, latestVersion: '1.2.3' });
    mockExecFile('"2.0.0"');

    const result = await checkForUpdate({ packageName: 'uplnk', enabled: true });

    expect(childProcess.execFile).toHaveBeenCalled();
    expect(result?.updateAvailable).toBe(true);
    expect(result?.latestVersion).toBe('2.0.0');
  });

  it('fetches from npm when no cache exists', async () => {
    mockCacheFile(null);
    mockExecFile('"1.5.0"');

    const result = await checkForUpdate({ packageName: 'uplnk', enabled: true });

    expect(childProcess.execFile).toHaveBeenCalled();
    expect(result?.updateAvailable).toBe(true);
    expect(result?.currentVersion).toBe('1.2.3');
    expect(result?.latestVersion).toBe('1.5.0');
    expect(result?.updateCommand).toContain('uplnk');
  });

  it('returns updateAvailable=false when already at latest', async () => {
    mockCacheFile(null);
    mockExecFile('"1.2.3"');

    const result = await checkForUpdate({ packageName: 'uplnk', enabled: true });

    expect(result?.updateAvailable).toBe(false);
    expect(result?.updateCommand).toBeNull();
  });

  it('returns null on network error', async () => {
    mockCacheFile(null);
    mockExecFileError('Network timeout');

    const result = await checkForUpdate({ packageName: 'uplnk', enabled: true });

    expect(result).toBeNull();
  });

  it('writes cache after successful fetch', async () => {
    mockCacheFile(null);
    mockExecFile('"2.0.0"');

    await checkForUpdate({ packageName: 'uplnk', enabled: true });

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('update-check.json'),
      expect.stringContaining('2.0.0'),
      'utf-8',
    );
  });
});

// ─── performUpdate ────────────────────────────────────────────────────────────

describe('performUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['npm_config_user_agent'];
  });

  afterEach(() => {
    delete process.env['npm_config_user_agent'];
  });

  it('calls execFile with npm install -g when no user agent is set', async () => {
    (childProcess.execFile as unknown as ExecFileMock).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: '', stderr: '' });
      },
    );

    const lines: string[] = [];
    await performUpdate('uplnk', (line) => lines.push(line));

    expect(lines[0]).toContain('npm install -g uplnk');
    expect(lines[lines.length - 1]).toContain('Update complete');
    expect(childProcess.execFile).toHaveBeenCalledWith(
      'npm',
      expect.arrayContaining(['install', '-g', 'uplnk']),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('uses pnpm when npm_config_user_agent starts with pnpm', async () => {
    process.env['npm_config_user_agent'] = 'pnpm/8.0.0 npm/? node/v20.0.0 linux x64';
    (childProcess.execFile as unknown as ExecFileMock).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: '', stderr: '' });
      },
    );

    const lines: string[] = [];
    await performUpdate('uplnk', (line) => lines.push(line));

    expect(lines[0]).toContain('pnpm add -g uplnk');
    expect(childProcess.execFile).toHaveBeenCalledWith(
      'pnpm',
      expect.arrayContaining(['add', '-g', 'uplnk']),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('uses yarn when npm_config_user_agent starts with yarn', async () => {
    process.env['npm_config_user_agent'] = 'yarn/3.6.0 npm/? node/v20.0.0 linux x64';
    (childProcess.execFile as unknown as ExecFileMock).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: '', stderr: '' });
      },
    );

    const lines: string[] = [];
    await performUpdate('uplnk', (line) => lines.push(line));

    expect(lines[0]).toContain('yarn global add uplnk');
    expect(childProcess.execFile).toHaveBeenCalledWith(
      'yarn',
      expect.arrayContaining(['global', 'add', 'uplnk']),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('propagates execFile error when the update command fails', async () => {
    (childProcess.execFile as unknown as ExecFileMock).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
        cb(new Error('Command failed: npm install'));
      },
    );

    await expect(performUpdate('uplnk', () => undefined)).rejects.toThrow('Command failed');
  });
});

// ─── detectPackageManager (via checkForUpdate updateCommand) ──────────────────

describe('detectPackageManager via updateCommand output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['npm_config_user_agent'];
    delete process.env['UPLNK_NO_UPDATE'];
    delete process.env['CI'];
  });

  afterEach(() => {
    delete process.env['npm_config_user_agent'];
  });

  it('updateCommand uses npm by default', async () => {
    mockCacheFile(null);
    mockExecFile('"2.0.0"');

    const result = await checkForUpdate({ packageName: 'uplnk', enabled: true });
    expect(result?.updateCommand).toBe('npm install -g uplnk');
  });

  it('updateCommand uses pnpm when user agent is pnpm', async () => {
    process.env['npm_config_user_agent'] = 'pnpm/8.0.0 npm/? node/v20.0.0';
    mockCacheFile(null);
    mockExecFile('"2.0.0"');

    const result = await checkForUpdate({ packageName: 'uplnk', enabled: true });
    expect(result?.updateCommand).toBe('pnpm add -g uplnk');
  });

  it('updateCommand uses yarn when user agent is yarn', async () => {
    process.env['npm_config_user_agent'] = 'yarn/3.6.0 npm/? node/v20.0.0';
    mockCacheFile(null);
    mockExecFile('"2.0.0"');

    const result = await checkForUpdate({ packageName: 'uplnk', enabled: true });
    expect(result?.updateCommand).toBe('yarn global add uplnk');
  });
});

describe('isNewer (via checkForUpdate behaviour)', () => {
  it('detects patch update (1.2.3 → 1.2.4)', async () => {
    mockCacheFile({ lastChecked: new Date(0).toISOString(), latestVersion: '1.2.4' });
    mockExecFile('"1.2.4"');

    const result = await checkForUpdate({ packageName: 'uplnk', enabled: true });
    expect(result?.updateAvailable).toBe(true);
  });

  it('detects minor update (1.2.3 → 1.3.0)', async () => {
    mockCacheFile(null);
    mockExecFile('"1.3.0"');

    const result = await checkForUpdate({ packageName: 'uplnk', enabled: true });
    expect(result?.updateAvailable).toBe(true);
  });

  it('does not flag downgrade as update (1.2.3 → 1.1.0)', async () => {
    mockCacheFile(null);
    mockExecFile('"1.1.0"');

    const result = await checkForUpdate({ packageName: 'uplnk', enabled: true });
    expect(result?.updateAvailable).toBe(false);
  });
});
