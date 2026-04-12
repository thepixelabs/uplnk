/**
 * Global test setup — runs before any test module is imported in a worker.
 *
 * Responsibilities:
 *  1. Redirect os.homedir() to a stable fake path so tests that call
 *     getPylonDir() (which resolves relative to homedir) never touch the real
 *     ~/.uplnk directory on the developer's machine.
 *  2. Stub uplnk-db at the module level so tests that import config.ts
 *     (or any module that imports uplnk-db) do not open / migrate a real
 *     SQLite file.  Each individual test file is free to override these stubs
 *     with its own vi.mock() factory — per-file vi.mock() calls take precedence
 *     over the global stub here.
 *  3. Reset mock call history between tests so state does not leak across
 *     test boundaries.
 *  4. Restore real timers after each test as a safety net — tests that call
 *     vi.useFakeTimers() must also restore real timers, but this ensures any
 *     that forget do not corrupt subsequent tests.
 *
 * Why here and not in individual test files?
 *  setupFiles run in the module scope of every test worker before the first
 *  describe block is evaluated. Putting environment-level stubs here means
 *  test files that are not directly testing DB or config behaviour do not need
 *  boilerplate — they inherit a clean, safe baseline.
 */

import { vi, beforeEach, afterEach } from 'vitest';

// ─── 1. Stable homedir — prevents tests from writing to ~/.uplnk ──────────────

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => '/tmp/uplnk-test-home',
  };
});

// ─── 2. In-memory uplnk-db stub ───────────────────────────────────────────────
//
// Real uplnk-db opens a SQLite file via better-sqlite3. In tests we replace the
// whole module with vi.fn() stubs so no file I/O occurs. The stub surface covers
// every export that application code currently imports from uplnk-db.
//
// Tests that need specific return values override per-describe via vi.mocked()
// or re-declare the mock entirely with vi.mock('@uplnk/db', () => ({ ... })).
//
// The names here must match the actual exports in packages/db/src/index.ts.

vi.mock('@uplnk/db', () => ({
  db: {},
  // Schema tables (used as query builder inputs — export empty objects)
  ragChunks: {},
  // Path helpers
  getPylonDir: vi.fn(() => '/tmp/uplnk-test-home/.uplnk'),
  getPylonDbPath: vi.fn(() => '/tmp/uplnk-test-home/.uplnk/db.sqlite'),
  // Provider config queries
  upsertProviderConfig: vi.fn(),
  getDefaultProvider: vi.fn(() => undefined),
  listProviders: vi.fn(() => []),
  // Conversation queries
  createConversation: vi.fn(() => ({ id: 'test-conv-id', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), title: 'New conversation', providerId: null, modelId: null, totalInputTokens: 0, totalOutputTokens: 0, deletedAt: null })),
  getConversation: vi.fn(() => undefined),
  listConversations: vi.fn(() => []),
  updateConversationTitle: vi.fn(),
  softDeleteConversation: vi.fn(),
  touchConversation: vi.fn(),
  // Message queries
  insertMessage: vi.fn(),
  getMessages: vi.fn(() => []),
  // Migration — in tests this should never run against a real file
  runMigrations: vi.fn(),
}));

// ─── 3. Clear mock call history between every test ────────────────────────────
//
// clearAllMocks() resets call counts, arguments, and return values on all
// vi.fn() instances without removing the mock implementations set by vi.mock()
// factories above. This prevents test A's observed calls from appearing as
// evidence in test B.

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── 4. Restore real timers after each test ───────────────────────────────────
//
// Tests that call vi.useFakeTimers() must restore real timers in their own
// afterEach. This global afterEach is a safety net: if a test forgets, the next
// test in the same worker inherits fake timers, causing subtle timing-related
// failures that are difficult to diagnose.

afterEach(() => {
  vi.useRealTimers();
});
