/**
 * Tests for seedConfigProviders (called by getOrCreateConfig).
 *
 * Isolated from the broader config.test.ts because we need to add
 * setDefaultProvider and getProviderById to the uplnk-db mock surface,
 * which would conflict with the narrower mock in the sibling file.
 *
 * Strategy: mock at the uplnk-db and node:fs boundaries. Each test
 * exercises a distinct behaviour of the seeding loop — single reason to fail.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Module mocks (hoisted before any import of the module under test) ────────

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('@uplnk/db', () => ({
  db: {},
  getUplnkDir: vi.fn(() => '/home/testuser/.uplnk'),
  upsertProviderConfig: vi.fn(),
  getDefaultProvider: vi.fn(() => undefined),
  getProviderById: vi.fn(() => undefined),
  setDefaultProvider: vi.fn(),
}));

// ─── Imports after mocks ───────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import {
  getUplnkDir,
  upsertProviderConfig,
  getDefaultProvider,
  getProviderById,
  setDefaultProvider,
} from '@uplnk/db';
import { getOrCreateConfig } from '../lib/config.js';

// ─── Typed helpers ────────────────────────────────────────────────────────────

const mockReadFileSync = vi.mocked(readFileSync);
const mockGetUplnkDir = vi.mocked(getUplnkDir);
const mockUpsertProviderConfig = vi.mocked(upsertProviderConfig);
const mockGetDefaultProvider = vi.mocked(getDefaultProvider);
const mockGetProviderById = vi.mocked(getProviderById);
const mockSetDefaultProvider = vi.mocked(setDefaultProvider);

const UPLNK_DIR = '/home/testuser/.uplnk';

/** A valid serialised config with zero extra providers. */
function makeRawConfig(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    theme: 'dark',
    mcp: { allowedPaths: [], commandExecEnabled: false },
    ...overrides,
  });
}

/** A minimal provider row shape returned by getProviderById. */
function fakeProviderRow(id: string) {
  return {
    id,
    name: 'Test Provider',
    providerType: 'ollama' as const,
    baseUrl: 'http://localhost:11434/v1',
    apiKey: null,
    defaultModel: null,
    isDefault: false,
    authMode: 'none' as const,
    lastTestedAt: null,
    lastTestStatus: null,
    lastTestDetail: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUplnkDir.mockReturnValue(UPLNK_DIR);
  // Default: no default provider, so seedDefaultProvider always upserts.
  mockGetDefaultProvider.mockReturnValue(undefined);
  // Default: getProviderById returns undefined (not found).
  mockGetProviderById.mockReturnValue(undefined);
});

// ─── seedConfigProviders via getOrCreateConfig ────────────────────────────────

describe('seedConfigProviders — empty providers list', () => {
  it('does not call upsertProviderConfig for any config provider (only the default-seed call)', () => {
    mockReadFileSync.mockReturnValue(makeRawConfig({ providers: [] }));

    getOrCreateConfig();

    // seedDefaultProvider calls upsert once for ollama-local. seedConfigProviders
    // must add zero additional calls.
    expect(mockUpsertProviderConfig).toHaveBeenCalledOnce();
  });

  it('does not call setDefaultProvider when providers list is empty', () => {
    mockReadFileSync.mockReturnValue(makeRawConfig({ providers: [] }));

    getOrCreateConfig();

    expect(mockSetDefaultProvider).not.toHaveBeenCalled();
  });
});

describe('seedConfigProviders — two providers, neither default', () => {
  const twoProviders = [
    {
      id: 'provider-a',
      name: 'Provider A',
      providerType: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      authMode: 'none',
      isDefault: false,
    },
    {
      id: 'provider-b',
      name: 'Provider B',
      providerType: 'openai-compatible',
      baseUrl: 'http://localhost:8080/v1',
      authMode: 'api-key',
      isDefault: false,
    },
  ];

  it('upserts both providers (total 3 calls: 1 default-seed + 2 config)', () => {
    mockReadFileSync.mockReturnValue(makeRawConfig({ providers: twoProviders }));

    getOrCreateConfig();

    // 1 call from seedDefaultProvider + 2 from seedConfigProviders.
    expect(mockUpsertProviderConfig).toHaveBeenCalledTimes(3);
  });

  it('does not call setDefaultProvider when no provider has isDefault: true', () => {
    mockReadFileSync.mockReturnValue(makeRawConfig({ providers: twoProviders }));

    getOrCreateConfig();

    expect(mockSetDefaultProvider).not.toHaveBeenCalled();
  });

  it('upserts provider-a with the correct id and providerType', () => {
    mockReadFileSync.mockReturnValue(makeRawConfig({ providers: twoProviders }));

    getOrCreateConfig();

    expect(mockUpsertProviderConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'provider-a', providerType: 'ollama' }),
    );
  });

  it('upserts provider-b with the correct id and providerType', () => {
    mockReadFileSync.mockReturnValue(makeRawConfig({ providers: twoProviders }));

    getOrCreateConfig();

    expect(mockUpsertProviderConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'provider-b', providerType: 'openai-compatible' }),
    );
  });
});

describe('seedConfigProviders — one provider with isDefault: true', () => {
  const defaultProvider = [
    {
      id: 'my-provider',
      name: 'My Provider',
      providerType: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      authMode: 'api-key',
      apiKey: 'sk-ant-test',
      isDefault: true,
    },
  ];

  it('calls setDefaultProvider with the provider id after upsert', () => {
    mockReadFileSync.mockReturnValue(makeRawConfig({ providers: defaultProvider }));
    // Simulate that getProviderById finds the just-upserted row.
    mockGetProviderById.mockReturnValue(fakeProviderRow('my-provider'));

    getOrCreateConfig();

    expect(mockSetDefaultProvider).toHaveBeenCalledWith(
      expect.anything(),
      'my-provider',
    );
  });

  it('calls setDefaultProvider exactly once for a single default provider', () => {
    mockReadFileSync.mockReturnValue(makeRawConfig({ providers: defaultProvider }));
    mockGetProviderById.mockReturnValue(fakeProviderRow('my-provider'));

    getOrCreateConfig();

    expect(mockSetDefaultProvider).toHaveBeenCalledOnce();
  });

  it('does not call setDefaultProvider when getProviderById returns undefined (upsert may have failed)', () => {
    mockReadFileSync.mockReturnValue(makeRawConfig({ providers: defaultProvider }));
    // getProviderById returns undefined → guard in seedConfigProviders prevents the call.
    mockGetProviderById.mockReturnValue(undefined);

    getOrCreateConfig();

    expect(mockSetDefaultProvider).not.toHaveBeenCalled();
  });
});

describe('seedConfigProviders — two providers both marked isDefault: true', () => {
  const twoDefaults = [
    {
      id: 'first-default',
      name: 'First Default',
      providerType: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      authMode: 'none',
      isDefault: true,
    },
    {
      id: 'second-default',
      name: 'Second Default',
      providerType: 'ollama',
      baseUrl: 'http://localhost:11435/v1',
      authMode: 'none',
      isDefault: true,
    },
  ];

  it('last one wins: setDefaultProvider is called with the last default id', () => {
    mockReadFileSync.mockReturnValue(makeRawConfig({ providers: twoDefaults }));
    mockGetProviderById.mockReturnValue(fakeProviderRow('second-default'));

    getOrCreateConfig();

    // The loop overwrites explicitDefaultId on each isDefault: true entry.
    // Only one setDefaultProvider call is made (after the loop).
    expect(mockSetDefaultProvider).toHaveBeenCalledOnce();
    expect(mockSetDefaultProvider).toHaveBeenCalledWith(
      expect.anything(),
      'second-default',
    );
  });
});

describe('seedConfigProviders — apiKey handling', () => {
  it('passes plaintext apiKey through to upsertProviderConfig', () => {
    const providers = [
      {
        id: 'plain-key-provider',
        name: 'Plain Key',
        providerType: 'openai',
        baseUrl: 'https://api.openai.com',
        authMode: 'api-key',
        apiKey: 'sk-live-openai-key',
        isDefault: false,
      },
    ];
    mockReadFileSync.mockReturnValue(makeRawConfig({ providers }));

    getOrCreateConfig();

    // Security fix (post qa-gate): plaintext `apiKey` from config.json is
    // routed through migratePlaintext → the api_key column only stores a
    // `@secret:` ref, never the raw key.
    const call = mockUpsertProviderConfig.mock.calls.find(
      ([, data]: [unknown, { id?: string }]) => data.id === 'plain-key-provider',
    );
    expect(call).toBeDefined();
    const written = (call as [unknown, { apiKey: string }])[1];
    expect(written.apiKey).toMatch(/^@secret:[0-9a-f]{32}$/);
  });

  it('writes apiKeySecretRef value into the api_key column when apiKey is absent', () => {
    const providers = [
      {
        id: 'ref-provider',
        name: 'Ref Provider',
        providerType: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        authMode: 'api-key',
        apiKeySecretRef: '@secret:abc123def456',
        isDefault: false,
      },
    ];
    mockReadFileSync.mockReturnValue(makeRawConfig({ providers }));

    getOrCreateConfig();

    expect(mockUpsertProviderConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ apiKey: '@secret:abc123def456' }),
    );
  });

  it('prefers apiKey over apiKeySecretRef when both are present', () => {
    const providers = [
      {
        id: 'both-provider',
        name: 'Both',
        providerType: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        authMode: 'api-key',
        apiKey: 'direct-key',
        apiKeySecretRef: '@secret:shouldnotbeused',
        isDefault: false,
      },
    ];
    mockReadFileSync.mockReturnValue(makeRawConfig({ providers }));

    getOrCreateConfig();

    // apiKey wins over apiKeySecretRef. Plaintext `direct-key` is migrated
    // into a fresh `@secret:` ref, NOT the `shouldnotbeused` ref that was
    // only there as a decoy.
    const call = mockUpsertProviderConfig.mock.calls.find(
      ([, data]: [unknown, { id?: string }]) => data.id === 'both-provider',
    );
    expect(call).toBeDefined();
    const written = (call as [unknown, { apiKey: string }])[1];
    expect(written.apiKey).toMatch(/^@secret:[0-9a-f]{32}$/);
    expect(written.apiKey).not.toBe('@secret:shouldnotbeused');
  });

  it('sets apiKey to null when neither apiKey nor apiKeySecretRef is present', () => {
    const providers = [
      {
        id: 'no-key-provider',
        name: 'No Key',
        providerType: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        authMode: 'none',
        isDefault: false,
      },
    ];
    mockReadFileSync.mockReturnValue(makeRawConfig({ providers }));

    getOrCreateConfig();

    expect(mockUpsertProviderConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ apiKey: null }),
    );
  });
});
