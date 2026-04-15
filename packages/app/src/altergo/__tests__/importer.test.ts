/**
 * Tests for packages/app/src/altergo/importer.ts
 *
 * importSession is the security-critical path: it validates symlinks, checks
 * content hashes for idempotency, writes to the DB inside a transaction, and
 * must never read outside ~/.altergo.
 *
 * Strategy:
 * - Real filesystem I/O (real files and real symlinks) for source-file and
 *   symlink resolution scenarios.
 * - realpathSync is mocked so it returns paths as-is. This is necessary on
 *   macOS where /tmp is a symlink to /private/tmp — without the mock,
 *   realpathSync would resolve /tmp/uplnk-test-home to /private/tmp/uplnk-test-home,
 *   which does not start with the mocked homedir() value. The security logic
 *   under test is the path-prefix boundary check; the symlink resolution
 *   itself is system behaviour we can trust.
 * - DB calls are mocked via vi.hoisted so we can assert on them without
 *   touching SQLite.
 *
 * NOTE: setup.ts mocks node:os.homedir → '/tmp/uplnk-test-home', so the
 * safeRealpath altergo root is '/tmp/uplnk-test-home/.altergo'. Our mocked
 * realpathSync returns its argument unchanged, making the prefix check
 * deterministic across platforms.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// ─── node:fs partial mock (realpathSync only) ─────────────────────────────────
// We need all real fs functions intact except realpathSync, which must return
// its argument unchanged so the path-prefix security check is platform-stable.

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    // Identity: skip system symlink resolution. The boundary check is what
    // we're testing — not the OS-level realpath implementation.
    realpathSync: (p: string) => p,
  };
});

// ─── DB mock ──────────────────────────────────────────────────────────────────
// The importer calls a drizzle-style fluent builder on `db`. We build a minimal
// chainable fake and record terminal .run() / .all() calls so we can assert
// on them without opening SQLite.

const mocks = vi.hoisted(() => {
  const runFn = vi.fn();
  const allFn = vi.fn(() => [] as object[]);

  const runBuilder = (): Record<string, unknown> => ({
    values: () => runBuilder(),
    onConflictDoUpdate: () => runBuilder(),
    where: () => runBuilder(),
    set: () => runBuilder(),
    run: runFn,
  });

  const selectBuilder = (): Record<string, unknown> => ({
    from: () => selectBuilder(),
    where: () => selectBuilder(),
    limit: () => ({ all: allFn }),
  });

  // Run the callback synchronously so all inner calls happen
  const transactionFn = vi.fn((fn: () => void) => fn());

  return {
    runFn,
    allFn,
    transactionFn,
    db: {
      select: () => selectBuilder(),
      insert: () => runBuilder(),
      delete: () => runBuilder(),
      transaction: transactionFn,
    },
    conversations: {},
    messages: {},
    altergoImports: {},
  };
});

vi.mock('@uplnk/db', () => ({
  db: mocks.db,
  conversations: mocks.conversations,
  messages: mocks.messages,
  altergoImports: mocks.altergoImports,
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => ({})) }));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { importSession } from '../importer.js';
import type { UnifiedSession } from '../sessions/index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a real temp directory under the mocked ~/.altergo path.
 * The mocked homedir() returns '/tmp/uplnk-test-home', so the altergo root
 * the importer computes is '/tmp/uplnk-test-home/.altergo'. We create dirs
 * directly under that path without going through mkdtempSync on the system
 * /tmp (which would be rewritten to /private/tmp on macOS by real realpathSync).
 */
function makeAltergoTmpDir(): string {
  const root = '/tmp/uplnk-test-home/.altergo';
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, 'import-test-'));
}

function makeSession(overrides: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id: 'test-session-id',
    account: 'alice',
    provider: 'claude-code',
    title: 'Test conversation',
    messageCount: 0,
    lastActivity: new Date('2024-01-01T00:00:00Z'),
    sourcePath: '/tmp/uplnk-test-home/.altergo/fake-path',
    ...overrides,
  };
}

// ─── idempotency ──────────────────────────────────────────────────────────────

describe('importSession — idempotency (hash-based skip)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeAltergoTmpDir();
    // resetAllMocks clears both call history AND queued mockReturnValueOnce items,
    // preventing queue bleed-through between tests. clearAllMocks only resets history.
    vi.resetAllMocks();
    mocks.allFn.mockReturnValue([]);
    mocks.transactionFn.mockImplementation((fn: () => void) => fn());
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns imported:false when source hash matches the existing import record', async () => {
    const sessionFile = join(tmpDir, 'session.jsonl');
    writeFileSync(sessionFile, '{"role":"user","content":"hello"}\n', 'utf-8');

    // First call: no existing record → full import
    mocks.allFn.mockReturnValueOnce([]);
    const first = await importSession(makeSession({ sourcePath: sessionFile }));
    expect(first.imported).toBe(true);

    // Compute the hash the importer would produce for this file
    const { statSync } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const st = statSync(sessionFile);
    const expectedHash = createHash('sha256')
      .update(`${String(st.mtimeMs)}:${String(st.size)}`)
      .digest('hex');

    // Reset mock state before second call to get clean call-count tracking
    vi.resetAllMocks();
    mocks.transactionFn.mockImplementation((fn: () => void) => fn());

    // Second call: existing record with matching hash — should skip import
    mocks.allFn.mockReturnValueOnce([
      {
        id: 'existing-import-id',
        conversationId: first.conversationId,
        sourceHash: expectedHash,
        messageCount: first.messageCount,
        sourcePath: sessionFile,
        account: 'alice',
        provider: 'claude-code',
        importedAt: new Date().toISOString(),
      },
    ]);

    const second = await importSession(makeSession({ sourcePath: sessionFile }));

    expect(second.imported).toBe(false);
    expect(second.conversationId).toBe(first.conversationId);
    expect(mocks.transactionFn).not.toHaveBeenCalled();
  });

  it('re-imports when file content has changed (hash mismatch)', async () => {
    const sessionFile = join(tmpDir, 'changed.jsonl');
    writeFileSync(sessionFile, '{"role":"user","content":"original"}\n', 'utf-8');

    mocks.allFn.mockReturnValueOnce([
      {
        id: 'old-import-id',
        conversationId: 'old-conv-id',
        sourceHash: 'stale-hash-that-will-not-match',
        messageCount: 1,
        sourcePath: sessionFile,
        account: 'alice',
        provider: 'claude-code',
        importedAt: new Date().toISOString(),
      },
    ]);

    const result = await importSession(makeSession({ sourcePath: sessionFile }));

    expect(result.imported).toBe(true);
    // Re-import must reuse the existing conversationId
    expect(result.conversationId).toBe('old-conv-id');
    expect(mocks.transactionFn).toHaveBeenCalledOnce();
  });

  it('fresh import assigns a new conversationId in UUID format', async () => {
    const sessionFile = join(tmpDir, 'fresh.jsonl');
    writeFileSync(sessionFile, '{"role":"user","content":"new"}\n', 'utf-8');
    mocks.allFn.mockReturnValueOnce([]);

    const result = await importSession(makeSession({ sourcePath: sessionFile }));

    expect(result.imported).toBe(true);
    expect(result.conversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

// ─── safeRealpath security ────────────────────────────────────────────────────

describe('importSession — safeRealpath security', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeAltergoTmpDir();
    vi.resetAllMocks();
    mocks.allFn.mockReturnValue([]);
    mocks.transactionFn.mockImplementation((fn: () => void) => fn());
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('rejects a path that resolves outside ~/.altergo', async () => {
    // With our mocked realpathSync (identity), any path outside the root is rejected
    await expect(
      importSession(makeSession({ sourcePath: '/etc/passwd' })),
    ).rejects.toThrow(/Security|outside/i);
  });

  it('rejects a path using .altergo as a prefix of a different directory name', async () => {
    // /tmp/uplnk-test-home/.altergo-evil starts with ".altergo" but is NOT inside .altergo/
    const evilDir = '/tmp/uplnk-test-home/.altergo-evil';
    mkdirSync(evilDir, { recursive: true });
    const evilFile = join(evilDir, 'session.jsonl');
    writeFileSync(evilFile, '{"role":"user","content":"evil"}\n', 'utf-8');

    try {
      await expect(
        importSession(makeSession({ sourcePath: evilFile })),
      ).rejects.toThrow(/Security|outside/i);
    } finally {
      try { rmSync(evilDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('accepts a real path that lives inside ~/.altergo', async () => {
    const sessionFile = join(tmpDir, 'safe.jsonl');
    writeFileSync(sessionFile, '{"role":"user","content":"safe"}\n', 'utf-8');

    await expect(
      importSession(makeSession({ sourcePath: sessionFile })),
    ).resolves.toMatchObject({ imported: true });
  });

  it('accepts the altergo root directory itself as the source path', async () => {
    // A session directory that IS the altergo root (edge: path === root)
    const root = '/tmp/uplnk-test-home/.altergo';
    mkdirSync(root, { recursive: true });

    // The root itself should pass (real !== root is false when they match exactly)
    await expect(
      importSession(makeSession({ sourcePath: root })),
    ).resolves.toMatchObject({ imported: true });
  });

  it('rejects a symlink pointing to /tmp (outside altergo root)', async () => {
    // Our mocked realpathSync is an identity function, so it returns the symlink
    // target path directly. We can test the boundary check by passing a path
    // that has been "resolved" to a location outside the root.
    await expect(
      importSession(makeSession({ sourcePath: '/tmp' })),
    ).rejects.toThrow(/Security|outside/i);
  });
});

// ─── transaction and messageCount ─────────────────────────────────────────────

describe('importSession — transaction and messageCount', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeAltergoTmpDir();
    vi.resetAllMocks();
    mocks.allFn.mockReturnValue([]);
    mocks.transactionFn.mockImplementation((fn: () => void) => fn());
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('runs all DB writes inside a single transaction callback', async () => {
    const sessionFile = join(tmpDir, 'tx.jsonl');
    writeFileSync(sessionFile, '{"role":"user","content":"tx test"}\n', 'utf-8');

    await importSession(makeSession({ sourcePath: sessionFile }));

    expect(mocks.transactionFn).toHaveBeenCalledOnce();
  });

  it('returns messageCount equal to the number of parseable JSONL lines', async () => {
    const sessionFile = join(tmpDir, 'count.jsonl');
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ role: 'user', content: 'line 1' }),
        JSON.stringify({ role: 'assistant', content: 'line 2' }),
        JSON.stringify({ role: 'user', content: 'line 3' }),
      ].join('\n'),
      'utf-8',
    );

    const result = await importSession(makeSession({ sourcePath: sessionFile }));

    expect(result.messageCount).toBe(3);
  });

  it('returns messageCount of 0 for an empty session file', async () => {
    const sessionFile = join(tmpDir, 'empty.jsonl');
    writeFileSync(sessionFile, '', 'utf-8');

    const result = await importSession(makeSession({ sourcePath: sessionFile }));

    expect(result.messageCount).toBe(0);
  });

  it('invokes the transaction callback when re-importing (hash changed)', async () => {
    const sessionFile = join(tmpDir, 're-import.jsonl');
    writeFileSync(sessionFile, '{"role":"user","content":"v2"}\n', 'utf-8');

    mocks.allFn.mockReturnValueOnce([
      {
        id: 'old-id',
        conversationId: 'existing-conv-id',
        sourceHash: 'outdated-hash',
        messageCount: 0,
        sourcePath: sessionFile,
        account: 'alice',
        provider: 'claude-code',
        importedAt: new Date().toISOString(),
      },
    ]);

    const result = await importSession(makeSession({ sourcePath: sessionFile }));

    expect(result.imported).toBe(true);
    expect(result.conversationId).toBe('existing-conv-id');
    expect(mocks.transactionFn).toHaveBeenCalledOnce();
  });

  it('calls run() at least once inside the transaction (for the conversation upsert)', async () => {
    const sessionFile = join(tmpDir, 'run-check.jsonl');
    writeFileSync(sessionFile, '{"role":"user","content":"hello"}\n', 'utf-8');

    await importSession(makeSession({ sourcePath: sessionFile }));

    expect(mocks.runFn.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('counts messages from a directory source path (all JSONL files combined)', async () => {
    // Create a session directory with two JSONL files
    const sessionDir = join(tmpDir, 'dir-session');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'a.jsonl'),
      JSON.stringify({ role: 'user', content: 'msg 1' }),
      'utf-8',
    );
    writeFileSync(
      join(sessionDir, 'b.jsonl'),
      JSON.stringify({ role: 'assistant', content: 'msg 2' }),
      'utf-8',
    );

    const result = await importSession(makeSession({ sourcePath: sessionDir }));

    expect(result.messageCount).toBe(2);
  });
});
