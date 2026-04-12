/**
 * Tests for runPruneSecrets() in packages/app/src/lib/doctor.ts
 *
 * Strategy: mock uplnk-db and secrets.ts at the module boundary.
 * Observable behaviour: which refs get deleted, which are retained,
 * and the no-op path when the backend cannot enumerate refs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const {
  mockDb,
  mockListProviders,
  mockInitSecretsBackend,
  mockDeleteSecret,
  mockDeleteSecretsBulk,
  mockBackend,
  mockGetSecretsBackend,
  mockIsSecretRef,
} = vi.hoisted(() => {
  const mockDb = {};
  const mockListProviders = vi.fn(() => [] as Array<{ id: string; name: string; apiKey: string | null }>);
  const mockDeleteSecret = vi.fn();
  const mockDeleteSecretsBulk = vi.fn((refs: string[]) => refs.length);
  const mockBackend = {
    name: 'encrypted-file' as const,
    // vitest 2.x: vi.fn takes a single function-type argument, not [args, return]
    listRefs: vi.fn<() => string[] | null>(() => []),
    deleteSecret: mockDeleteSecret,
    deleteSecretsBulk: mockDeleteSecretsBulk,
    setSecret: vi.fn(),
    getSecret: vi.fn(),
    close: vi.fn(),
  };
  const mockInitSecretsBackend = vi.fn(async () => mockBackend);
  const mockGetSecretsBackend = vi.fn(() => mockBackend);
  const mockIsSecretRef = vi.fn((v: string) => v.startsWith('@secret:'));
  return {
    mockDb,
    mockListProviders,
    mockInitSecretsBackend,
    mockDeleteSecret,
    mockDeleteSecretsBulk,
    mockBackend,
    mockGetSecretsBackend,
    mockIsSecretRef,
  };
});

vi.mock('@uplnk/db', () => ({
  db: mockDb,
  listProviders: mockListProviders,
  setProviderApiKey: vi.fn(),
  getUplnkDir: vi.fn(() => '/tmp/uplnk-test-home/.uplnk'),
  getUplnkDbPath: vi.fn(() => '/tmp/uplnk-test-home/.uplnk/db.sqlite'),
}));

vi.mock('../secrets.js', () => ({
  initSecretsBackend: mockInitSecretsBackend,
  getSecretsBackend: mockGetSecretsBackend,
  migratePlaintext: vi.fn((v: string) => `@secret:${v}`),
  isSecretRef: mockIsSecretRef,
}));

import { runPruneSecrets } from '../doctor.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRow(id: string, name: string, apiKey: string | null) {
  return { id, name, apiKey };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runPruneSecrets — backend returns null from listRefs (keyring case)', () => {
  it('should print no-op message and not call deleteSecret', async () => {
    mockBackend.listRefs.mockReturnValue(null);
    mockListProviders.mockReturnValue([]);

    await runPruneSecrets();

    expect(mockDeleteSecret).not.toHaveBeenCalled();
  });
});

describe('runPruneSecrets — all refs are live', () => {
  it('should not delete any refs when every stored ref matches a provider row', async () => {
    mockBackend.listRefs.mockReturnValue(['@secret:ref-a', '@secret:ref-b']);
    mockListProviders.mockReturnValue([
      makeRow('p1', 'Provider A', '@secret:ref-a'),
      makeRow('p2', 'Provider B', '@secret:ref-b'),
    ]);

    await runPruneSecrets();

    expect(mockDeleteSecret).not.toHaveBeenCalled();
  });
});

describe('runPruneSecrets — one orphan', () => {
  it('should delete exactly the orphaned ref via the bulk path', async () => {
    mockBackend.listRefs.mockReturnValue(['@secret:live', '@secret:orphan']);
    mockListProviders.mockReturnValue([
      makeRow('p1', 'Provider A', '@secret:live'),
    ]);

    await runPruneSecrets();

    // Bulk path (security gate round 2 fix M4): one persist call total
    // instead of one per orphan.
    expect(mockDeleteSecretsBulk).toHaveBeenCalledTimes(1);
    expect(mockDeleteSecretsBulk).toHaveBeenCalledWith(['@secret:orphan']);
  });
});

describe('runPruneSecrets — multiple orphans, multiple live', () => {
  it('should delete only the orphaned refs and leave live refs untouched', async () => {
    mockBackend.listRefs.mockReturnValue([
      '@secret:live-1',
      '@secret:orphan-a',
      '@secret:live-2',
      '@secret:orphan-b',
    ]);
    mockListProviders.mockReturnValue([
      makeRow('p1', 'Provider 1', '@secret:live-1'),
      makeRow('p2', 'Provider 2', '@secret:live-2'),
    ]);

    await runPruneSecrets();

    expect(mockDeleteSecretsBulk).toHaveBeenCalledTimes(1);
    expect(mockDeleteSecretsBulk).toHaveBeenCalledWith(['@secret:orphan-a', '@secret:orphan-b']);
  });
});

describe('runPruneSecrets — empty provider list, refs in store', () => {
  it('should treat all stored refs as orphans and delete all of them', async () => {
    const refs = ['@secret:ref-1', '@secret:ref-2', '@secret:ref-3'];
    mockBackend.listRefs.mockReturnValue(refs);
    mockListProviders.mockReturnValue([]);

    await runPruneSecrets();

    expect(mockDeleteSecretsBulk).toHaveBeenCalledTimes(1);
    expect(mockDeleteSecretsBulk).toHaveBeenCalledWith(refs);
  });
});
