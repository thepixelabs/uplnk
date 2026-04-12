/**
 * Tests for runMigrateSecrets() in packages/app/src/lib/doctor.ts
 *
 * Strategy: mock pylon-db and secrets.ts at the module boundary.
 * Observable behaviour: which rows trigger migratePlaintext + setProviderApiKey,
 * which are silently skipped, and idempotency on the second pass.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks (must precede all imports) ─────────────────────────────────

const {
  mockDb,
  mockListProviders,
  mockSetProviderApiKey,
  mockInitSecretsBackend,
  mockGetSecretsBackend,
  mockMigratePlaintext,
  mockIsSecretRef,
} = vi.hoisted(() => {
  const mockDb = {};
  const mockListProviders = vi.fn(() => [] as Array<{ id: string; name: string; apiKey: string | null }>);
  const mockSetProviderApiKey = vi.fn();
  const mockInitSecretsBackend = vi.fn(async () => ({ name: 'encrypted-file' }));
  const mockGetSecretsBackend = vi.fn(() => ({ name: 'encrypted-file' }));
  const mockMigratePlaintext = vi.fn((v: string) => `@secret:${v}`);
  const mockIsSecretRef = vi.fn((v: string) => v.startsWith('@secret:'));
  return {
    mockDb,
    mockListProviders,
    mockSetProviderApiKey,
    mockInitSecretsBackend,
    mockGetSecretsBackend,
    mockMigratePlaintext,
    mockIsSecretRef,
  };
});

vi.mock('pylon-db', () => ({
  db: mockDb,
  listProviders: mockListProviders,
  setProviderApiKey: mockSetProviderApiKey,
  getPylonDir: vi.fn(() => '/tmp/pylon-test-home/.pylon'),
  getPylonDbPath: vi.fn(() => '/tmp/pylon-test-home/.pylon/db.sqlite'),
}));

vi.mock('../secrets.js', () => ({
  initSecretsBackend: mockInitSecretsBackend,
  getSecretsBackend: mockGetSecretsBackend,
  migratePlaintext: mockMigratePlaintext,
  isSecretRef: mockIsSecretRef,
}));

import { runMigrateSecrets } from '../doctor.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRow(id: string, name: string, apiKey: string | null) {
  return { id, name, apiKey };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runMigrateSecrets — empty provider list', () => {
  it('should report nothing to migrate and not call setProviderApiKey', async () => {
    mockListProviders.mockReturnValue([]);

    await runMigrateSecrets();

    expect(mockSetProviderApiKey).not.toHaveBeenCalled();
  });
});

describe('runMigrateSecrets — single plaintext key', () => {
  it('should call migratePlaintext with the raw value and write a ref back', async () => {
    mockListProviders.mockReturnValue([makeRow('p1', 'MyProvider', 'sk-rawkey')]);
    mockMigratePlaintext.mockReturnValue('@secret:sk-rawkey');

    await runMigrateSecrets();

    expect(mockMigratePlaintext).toHaveBeenCalledWith('sk-rawkey');
    expect(mockSetProviderApiKey).toHaveBeenCalledWith(mockDb, 'p1', '@secret:sk-rawkey');
  });
});

describe('runMigrateSecrets — already-ref key (idempotency)', () => {
  it('should not call setProviderApiKey when api_key is already a @secret: ref', async () => {
    mockListProviders.mockReturnValue([makeRow('p1', 'MyProvider', '@secret:abc123')]);

    await runMigrateSecrets();

    expect(mockSetProviderApiKey).not.toHaveBeenCalled();
  });
});

describe('runMigrateSecrets — null api_key', () => {
  it('should skip rows with null api_key without calling migratePlaintext or setProviderApiKey', async () => {
    mockListProviders.mockReturnValue([makeRow('p1', 'NoKey', null)]);

    await runMigrateSecrets();

    expect(mockMigratePlaintext).not.toHaveBeenCalled();
    expect(mockSetProviderApiKey).not.toHaveBeenCalled();
  });
});

describe('runMigrateSecrets — ollama placeholder', () => {
  it('should skip rows with api_key === "ollama" without migrating', async () => {
    mockListProviders.mockReturnValue([makeRow('p1', 'LocalOllama', 'ollama')]);

    await runMigrateSecrets();

    expect(mockMigratePlaintext).not.toHaveBeenCalled();
    expect(mockSetProviderApiKey).not.toHaveBeenCalled();
  });
});

describe('runMigrateSecrets — mixed batch', () => {
  it('should migrate only the plaintext row and skip the ref, null, and ollama rows', async () => {
    mockListProviders.mockReturnValue([
      makeRow('p1', 'AlreadyRef',  '@secret:existing'),
      makeRow('p2', 'Plaintext',   'sk-real-key'),
      makeRow('p3', 'NullKey',     null),
      makeRow('p4', 'OllamaLocal', 'ollama'),
    ]);
    mockMigratePlaintext.mockReturnValue('@secret:sk-real-key');

    await runMigrateSecrets();

    expect(mockMigratePlaintext).toHaveBeenCalledTimes(1);
    expect(mockMigratePlaintext).toHaveBeenCalledWith('sk-real-key');
    expect(mockSetProviderApiKey).toHaveBeenCalledTimes(1);
    expect(mockSetProviderApiKey).toHaveBeenCalledWith(mockDb, 'p2', '@secret:sk-real-key');
  });
});

describe('runMigrateSecrets — second run after successful first run', () => {
  it('should perform zero migrations when all rows already have @secret: refs', async () => {
    // Simulate state after a first successful migration: all rows now hold refs
    mockListProviders.mockReturnValue([
      makeRow('p1', 'Provider A', '@secret:ref-a'),
      makeRow('p2', 'Provider B', '@secret:ref-b'),
    ]);

    await runMigrateSecrets();

    expect(mockMigratePlaintext).not.toHaveBeenCalled();
    expect(mockSetProviderApiKey).not.toHaveBeenCalled();
  });
});
