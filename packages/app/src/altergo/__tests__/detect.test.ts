/**
 * Tests for packages/app/src/altergo/detect.ts
 *
 * detectAltergo shells out to `which` and then runs `<binary> --version`.
 * We mock node:child_process so no subprocess is ever spawned.
 *
 * getAltergoHome is pure path manipulation — tested with direct assertions.
 *
 * Note: detect.ts imports homedir() at call-time; setup.ts already mocks
 * node:os.homedir → '/tmp/uplnk-test-home', so all home assertions use
 * that stable value.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── child_process mock ───────────────────────────────────────────────────────
// detect.ts uses execSync from node:child_process. We mock the whole module
// so no shell command is ever executed during tests.

const mocks = vi.hoisted(() => ({
  execSync: vi.fn<(cmd: string, opts?: object) => string>(),
}));

vi.mock('node:child_process', () => ({
  execSync: mocks.execSync,
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { detectAltergo, getAltergoHome } from '../detect.js';

// ─── detectAltergo ────────────────────────────────────────────────────────────

describe('detectAltergo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns installed:false when `which` throws (binary not in PATH)', () => {
    mocks.execSync.mockImplementation(() => {
      throw new Error('which: altergo: not found');
    });

    const result = detectAltergo();

    expect(result.installed).toBe(false);
    expect(result).not.toHaveProperty('binaryPath');
    expect(result).not.toHaveProperty('version');
  });

  it('returns installed:false when `which` returns an empty string', () => {
    mocks.execSync.mockReturnValueOnce('   '); // only whitespace

    const result = detectAltergo();

    expect(result.installed).toBe(false);
  });

  it('returns installed:true with binaryPath when which succeeds', () => {
    mocks.execSync
      .mockReturnValueOnce('/usr/local/bin/altergo\n') // which
      .mockReturnValueOnce('altergo 1.2.3\n');          // --version

    const result = detectAltergo();

    expect(result.installed).toBe(true);
    expect(result.binaryPath).toBe('/usr/local/bin/altergo');
  });

  it('returns the version string stripped of surrounding whitespace', () => {
    mocks.execSync
      .mockReturnValueOnce('/usr/bin/altergo\n')
      .mockReturnValueOnce('  altergo 2.0.0  ');

    const result = detectAltergo();

    expect(result.version).toBe('altergo 2.0.0');
  });

  it('returns installed:true without a version field when --version throws', () => {
    mocks.execSync
      .mockReturnValueOnce('/usr/bin/altergo\n')
      .mockImplementationOnce(() => { throw new Error('--version failed'); });

    const result = detectAltergo();

    expect(result.installed).toBe(true);
    expect(result.binaryPath).toBe('/usr/bin/altergo');
    expect(result).not.toHaveProperty('version');
  });

  it('always includes the home field pointing to ~/.altergo', () => {
    mocks.execSync.mockImplementation(() => { throw new Error('not found'); });

    const result = detectAltergo();

    // setup.ts mocks homedir() → '/tmp/uplnk-test-home'
    expect(result.home).toBe('/tmp/uplnk-test-home/.altergo');
  });

  it('uses the custom binaryName argument for the which call', () => {
    mocks.execSync.mockImplementation(() => { throw new Error('not found'); });

    detectAltergo('my-custom-altergo');

    expect(mocks.execSync).toHaveBeenCalledWith(
      expect.stringContaining('my-custom-altergo'),
      expect.any(Object),
    );
  });

  it('defaults to "altergo" as the binary name', () => {
    mocks.execSync.mockImplementation(() => { throw new Error('not found'); });

    detectAltergo();

    expect(mocks.execSync).toHaveBeenCalledWith(
      'which altergo',
      expect.any(Object),
    );
  });

  it('returns installed:true for an altergo binary in a non-standard location', () => {
    mocks.execSync
      .mockReturnValueOnce('/home/user/.local/bin/altergo\n')
      .mockReturnValueOnce('altergo 0.9.1\n');

    const result = detectAltergo();

    expect(result.installed).toBe(true);
    expect(result.binaryPath).toBe('/home/user/.local/bin/altergo');
    expect(result.version).toBe('altergo 0.9.1');
  });
});

// ─── getAltergoHome ───────────────────────────────────────────────────────────

describe('getAltergoHome', () => {
  it('returns ~/.altergo when no configured path is given', () => {
    // homedir() mocked by setup.ts → '/tmp/uplnk-test-home'
    expect(getAltergoHome()).toBe('/tmp/uplnk-test-home/.altergo');
  });

  it('returns ~/.altergo when undefined is passed explicitly', () => {
    expect(getAltergoHome(undefined)).toBe('/tmp/uplnk-test-home/.altergo');
  });

  it('expands a leading ~ in the configured path', () => {
    expect(getAltergoHome('~/custom-altergo')).toBe('/tmp/uplnk-test-home/custom-altergo');
  });

  it('returns the configured path unchanged when it is already absolute (no leading ~)', () => {
    expect(getAltergoHome('/absolute/path/to/altergo')).toBe('/absolute/path/to/altergo');
  });

  it('handles a configured path that is exactly "~/.altergo"', () => {
    expect(getAltergoHome('~/.altergo')).toBe('/tmp/uplnk-test-home/.altergo');
  });
});
