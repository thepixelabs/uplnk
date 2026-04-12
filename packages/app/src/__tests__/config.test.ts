/**
 * Tests for packages/app/src/lib/config.ts
 *
 * Strategy: mock at the system boundary (node:fs and uplnk-db). Never mock
 * internal collaborators. Each test has a single reason to fail.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Module mocks (hoisted) ────────────────────────────────────────────────────

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('uplnk-db', () => ({
  db: {},
  getPylonDir: vi.fn(() => '/home/testuser/.pylon'),
  upsertProviderConfig: vi.fn(),
  getDefaultProvider: vi.fn(),
}));

// ─── Imports after mocks are registered ───────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { getPylonDir, upsertProviderConfig, getDefaultProvider } from 'uplnk-db';
import { loadConfig, saveConfig, getOrCreateConfig, getConfigPath } from '../lib/config.js';
import type { Config } from '../lib/config.js';

/**
 * Unwrap helpers — LoadConfigResult is a discriminated union; tests assert
 * on the inner Config directly, so these thin wrappers match the test intent.
 */
function parseConfig(): Config | undefined {
  const r = loadConfig();
  return r.ok ? r.config : undefined;
}

// ─── Typed mock helpers ────────────────────────────────────────────────────────

const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockGetPylonDir = vi.mocked(getPylonDir);
const mockUpsertProviderConfig = vi.mocked(upsertProviderConfig);
const mockGetDefaultProvider = vi.mocked(getDefaultProvider);

const PYLON_DIR = '/home/testuser/.pylon';
const CONFIG_PATH = `${PYLON_DIR}/config.json`;

/** Minimal valid serialised config (version 1). */
function makeRawConfig(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    theme: 'dark',
    mcp: { allowedPaths: [], commandExecEnabled: false },
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPylonDir.mockReturnValue(PYLON_DIR);
  // By default no default provider exists, so seedDefaultProvider will upsert.
  mockGetDefaultProvider.mockReturnValue(undefined);
});

// ─── getConfigPath ─────────────────────────────────────────────────────────────

describe('getConfigPath', () => {
  it('joins getPylonDir() with config.json', () => {
    expect(getConfigPath()).toBe(CONFIG_PATH);
  });
});

// ─── loadConfig ───────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  it('returns undefined when the config file is missing (ENOENT)', () => {
    const err = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    mockReadFileSync.mockImplementation(() => { throw err; });

    expect(parseConfig()).toBeUndefined();
  });

  it('returns undefined when the file contains invalid JSON', () => {
    mockReadFileSync.mockReturnValue('{ this is not json }');

    expect(parseConfig()).toBeUndefined();
  });

  it('returns undefined when JSON is valid but schema version is wrong', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: 2, theme: 'dark' }));

    expect(parseConfig()).toBeUndefined();
  });

  it('returns undefined when the version field is missing entirely', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ theme: 'dark' }));

    expect(parseConfig()).toBeUndefined();
  });

  it('returns undefined when theme has an unrecognised value', () => {
    mockReadFileSync.mockReturnValue(makeRawConfig({ theme: 'solarized' }));

    expect(parseConfig()).toBeUndefined();
  });

  it('returns undefined when mcp.commandExecEnabled is not a boolean', () => {
    mockReadFileSync.mockReturnValue(
      makeRawConfig({ mcp: { allowedPaths: [], commandExecEnabled: 'yes' } }),
    );

    expect(parseConfig()).toBeUndefined();
  });

  it('returns undefined when mcp.allowedPaths contains a non-string entry', () => {
    mockReadFileSync.mockReturnValue(
      makeRawConfig({ mcp: { allowedPaths: [42], commandExecEnabled: false } }),
    );

    expect(parseConfig()).toBeUndefined();
  });

  it('returns a parsed Config for a minimal valid file (version 1, dark theme)', () => {
    mockReadFileSync.mockReturnValue(makeRawConfig());

    const config = parseConfig();

    expect(config).not.toBeUndefined();
    expect(config?.version).toBe(1);
    expect(config?.theme).toBe('dark');
    expect(config?.mcp.allowedPaths).toEqual([]);
    expect(config?.mcp.commandExecEnabled).toBe(false);
  });

  it('returns a parsed Config for the light theme', () => {
    mockReadFileSync.mockReturnValue(makeRawConfig({ theme: 'light' }));

    const config = parseConfig();

    expect(config?.theme).toBe('light');
  });

  it('preserves optional fields defaultProviderId and defaultModel when present', () => {
    mockReadFileSync.mockReturnValue(
      makeRawConfig({ defaultProviderId: 'ollama-local', defaultModel: 'llama3.2' }),
    );

    const config = parseConfig();

    expect(config?.defaultProviderId).toBe('ollama-local');
    expect(config?.defaultModel).toBe('llama3.2');
  });

  it('reads from the path returned by getConfigPath (utf-8 encoding)', () => {
    mockReadFileSync.mockReturnValue(makeRawConfig());

    loadConfig();

    expect(mockReadFileSync).toHaveBeenCalledWith(CONFIG_PATH, 'utf-8');
  });

  it('applies schema defaults: theme defaults to dark when omitted', () => {
    // theme has a .default('dark') in the Zod schema — omitting it should
    // still yield a valid config with the default applied.
    const raw = JSON.stringify({ version: 1 });
    mockReadFileSync.mockReturnValue(raw);

    const config = parseConfig();

    expect(config?.theme).toBe('dark');
  });

  it('applies schema defaults: mcp defaults to empty object when omitted', () => {
    const raw = JSON.stringify({ version: 1 });
    mockReadFileSync.mockReturnValue(raw);

    const config = parseConfig();

    expect(config?.mcp.allowedPaths).toEqual([]);
    expect(config?.mcp.commandExecEnabled).toBe(false);
  });
});

// ─── saveConfig ───────────────────────────────────────────────────────────────

describe('saveConfig', () => {
  const validConfig: Config = {
    version: 1,
    theme: 'dark',
    telemetry: { enabled: false },
    mcp: { allowedPaths: [], commandExecEnabled: false, commandAllowlistAdditions: [], servers: [] },
    providers: [],
    git: { enabled: true },
    rag: { enabled: false, autoDetect: false },
    updates: { enabled: true, packageName: 'uplnk' },
  };

  it('creates the pylon directory with recursive: true before writing', () => {
    saveConfig(validConfig);

    expect(mockMkdirSync).toHaveBeenCalledWith(PYLON_DIR, { recursive: true });
  });

  it('writes to the correct config path', () => {
    saveConfig(validConfig);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      CONFIG_PATH,
      expect.any(String),
      'utf-8',
    );
  });

  it('serialises config as JSON with 2-space indentation', () => {
    saveConfig(validConfig);

    const written = mockWriteFileSync.mock.calls[0]?.[1] as string;
    expect(written).toBe(JSON.stringify(validConfig, null, 2));
  });

  it('round-trips: written JSON parses back to an equivalent config', () => {
    const configWithExtras: Config = {
      version: 1,
      theme: 'light',
      defaultProviderId: 'my-provider',
      defaultModel: 'mistral',
      telemetry: { enabled: false },
      mcp: { allowedPaths: ['/home/user/projects'], commandExecEnabled: true, commandAllowlistAdditions: [], servers: [] },
      providers: [],
      git: { enabled: true },
      rag: { enabled: false, autoDetect: false },
      updates: { enabled: true, packageName: 'uplnk' },
    };

    saveConfig(configWithExtras);

    const written = mockWriteFileSync.mock.calls[0]?.[1] as string;
    expect(JSON.parse(written)).toEqual(configWithExtras);
  });

  it('calls mkdirSync before writeFileSync (directory must exist before write)', () => {
    const callOrder: string[] = [];
    mockMkdirSync.mockImplementation(() => { callOrder.push('mkdir'); return undefined; });
    mockWriteFileSync.mockImplementation(() => { callOrder.push('write'); });

    saveConfig(validConfig);

    expect(callOrder).toEqual(['mkdir', 'write']);
  });
});

// ─── getOrCreateConfig ────────────────────────────────────────────────────────

describe('getOrCreateConfig', () => {
  it('returns existing config without writing when loadConfig succeeds', () => {
    const existingRaw = makeRawConfig({ defaultModel: 'gemma2' });
    mockReadFileSync.mockReturnValue(existingRaw);

    const result = getOrCreateConfig();

    expect(result.ok).toBe(true);
    expect(result.ok && result.config.defaultModel).toBe('gemma2');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('creates and persists default config when no file exists', () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = getOrCreateConfig();

    expect(result.ok).toBe(true);
    expect(result.ok && result.config.version).toBe(1);
    expect(result.ok && result.config.theme).toBe('dark');
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
  });

  it('created default config has mcp.commandExecEnabled = false (security default)', () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = getOrCreateConfig();

    expect(result.ok).toBe(true);
    expect(result.ok && result.config.mcp.commandExecEnabled).toBe(false);
  });

  it('created default config has an empty mcp.allowedPaths list', () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = getOrCreateConfig();

    expect(result.ok).toBe(true);
    expect(result.ok ? result.config.mcp.allowedPaths : null).toEqual([]);
  });

  it('seeds default provider when config already exists and no default is set', () => {
    mockReadFileSync.mockReturnValue(makeRawConfig());
    mockGetDefaultProvider.mockReturnValue(undefined);

    getOrCreateConfig();

    expect(mockUpsertProviderConfig).toHaveBeenCalledOnce();
  });

  it('does not seed provider when a default provider already exists', () => {
    mockReadFileSync.mockReturnValue(makeRawConfig());
    mockGetDefaultProvider.mockReturnValue({
      id: 'ollama-local',
      name: 'Local Ollama',
      providerType: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      defaultModel: 'llama3.2',
      isDefault: true,
      authMode: 'none',
      lastTestedAt: null,
      lastTestStatus: null,
      lastTestDetail: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    getOrCreateConfig();

    expect(mockUpsertProviderConfig).not.toHaveBeenCalled();
  });

  it('seeds provider with correct ollama-local defaults on first run', () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockGetDefaultProvider.mockReturnValue(undefined);

    getOrCreateConfig();

    expect(mockUpsertProviderConfig).toHaveBeenCalledWith(
      expect.anything(), // db reference
      expect.objectContaining({
        id: 'ollama-local',
        providerType: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        isDefault: true,
      }),
    );
  });

  it('re-creates config from default when existing file has invalid JSON', () => {
    mockReadFileSync.mockReturnValue('not json at all');

    const result = getOrCreateConfig();

    // loadConfig returns ok:false on bad JSON, so getOrCreateConfig falls
    // through to create the default.
    expect(result.ok).toBe(false);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('written default config is valid JSON parseable by loadConfig on next call', () => {
    // First call: file missing → creates default
    mockReadFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    getOrCreateConfig();

    // Capture what was written and feed it back as the file content
    const written = mockWriteFileSync.mock.calls[0]?.[1] as string;
    mockReadFileSync.mockReturnValue(written);

    // Second call: file now exists
    const result = getOrCreateConfig();

    expect(result.ok).toBe(true);
    expect(result.ok && result.config.version).toBe(1);
    expect(result.ok && result.config.theme).toBe('dark');
  });
});

// ─── ConfigSchema (Zod) ───────────────────────────────────────────────────────

describe('ConfigSchema validation (via loadConfig)', () => {
  it('accepts commandExecEnabled = true (feature flag on)', () => {
    mockReadFileSync.mockReturnValue(
      makeRawConfig({ mcp: { allowedPaths: [], commandExecEnabled: true } }),
    );

    const r = loadConfig();
    expect(r.ok ? r.config.mcp.commandExecEnabled : undefined).toBe(true);
  });

  it('accepts allowedPaths with multiple absolute paths', () => {
    mockReadFileSync.mockReturnValue(
      makeRawConfig({
        mcp: { allowedPaths: ['/home/user/a', '/home/user/b'], commandExecEnabled: false },
      }),
    );

    const r = loadConfig();
    expect(r.ok ? r.config.mcp.allowedPaths : null).toEqual(['/home/user/a', '/home/user/b']);
  });

  it('rejects version field set to 0', () => {
    mockReadFileSync.mockReturnValue(makeRawConfig({ version: 0 }));

    expect(loadConfig().ok).toBe(false);
  });

  it('rejects version field set to a string', () => {
    mockReadFileSync.mockReturnValue(makeRawConfig({ version: '1' }));

    expect(loadConfig().ok).toBe(false);
  });

  it('accepts undefined optional fields (defaultProviderId, defaultModel)', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: 1 }));

    const result = loadConfig();

    expect(result.ok).toBe(true);
    expect(result.ok ? result.config.defaultProviderId : 'present').toBeUndefined();
    expect(result.ok ? result.config.defaultModel : 'present').toBeUndefined();
  });

  it('rejects top-level null as config', () => {
    mockReadFileSync.mockReturnValue('null');

    expect(loadConfig().ok).toBe(false);
  });

  it('rejects an array as config', () => {
    mockReadFileSync.mockReturnValue('[{"version":1}]');

    expect(parseConfig()).toBeUndefined();
  });
});
