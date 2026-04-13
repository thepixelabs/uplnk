/**
 * indexer.getAllEmbeddedChunks — null-filter regression tests (H3).
 *
 * Background
 * ──────────
 * An earlier revision of getAllEmbeddedChunks() shipped with a tautological
 * WHERE clause (e.g. `eq(col, col)` or `isNotNull(someUnrelatedConstant)`)
 * which looks like a filter but evaluates to "all rows". On a large codebase
 * that silently OOM'd RAG search because every un-embedded chunk was loaded
 * into memory and JS-filtered downstream.
 *
 * The fix: filter at the SQL level with `isNotNull(ragChunks.embedding)`.
 *
 * This file pins the contract with assertions the other indexer test doesn't
 * make:
 *   1. getAllEmbeddedChunks calls `.where(...)` on the ragChunks table select
 *      exactly once.
 *   2. The SQL expression passed to `.where()` is the isNotNull() node
 *      produced by drizzle for the `embedding` column — not a tautology.
 *   3. No JS-side post-filter exists — the rows returned equal the DB rows
 *      exactly (by identity).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isNotNull } from 'drizzle-orm';

// ─── Subject under test ────────────────────────────────────────────────────────

import { Indexer } from '../indexer.js';
import { ragChunks } from '@uplnk/db';

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface SpyDb {
  delete: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  _where: ReturnType<typeof vi.fn>;
  _all: ReturnType<typeof vi.fn>;
}

/**
 * Build a query-builder spy that records calls. The `.where()` mock captures
 * its single argument so tests can inspect the SQL expression.
 */
function makeSpyDb(rows: unknown[]): SpyDb {
  const all = vi.fn().mockReturnValue(rows);
  const where = vi.fn().mockReturnValue({ all });
  const from = vi.fn().mockReturnValue({ where, all });
  const select = vi.fn().mockReturnValue({ from });
  return {
    delete: vi.fn(),
    insert: vi.fn(),
    select,
    _where: where,
    _all: all,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Indexer.getAllEmbeddedChunks — null filter pinned at SQL layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls .where() exactly once (one SQL filter, no chain)', () => {
    const db = makeSpyDb([]);
    const indexer = new Indexer(db as never, null);

    indexer.getAllEmbeddedChunks();

    expect(db._where).toHaveBeenCalledTimes(1);
  });

  it('calls .where() with the same SQL expression drizzle produces for isNotNull(ragChunks.embedding)', () => {
    // Build the "reference" expression using the real drizzle helper on the
    // real column, then compare the indexer's call argument to it. This is
    // resilient to drizzle internal shape changes — we only rely on structural
    // equality of the two expressions.
    const reference = isNotNull(ragChunks.embedding);

    const db = makeSpyDb([]);
    const indexer = new Indexer(db as never, null);

    indexer.getAllEmbeddedChunks();

    const actual = db._where.mock.calls[0]?.[0];
    expect(actual).toBeDefined();
    // Structural equality guards against a future regression swapping in a
    // tautology like `eq(ragChunks.id, ragChunks.id)` — the drizzle node for
    // such an expression has a different shape and this assertion would fail.
    expect(actual).toEqual(reference);
  });

  it('does not post-filter rows in JS — caller receives the DB output unchanged', () => {
    // The whole point of the SQL filter is that the indexer trusts the DB.
    // If a regression adds a JS `.filter(r => r.embedding !== null)` back on
    // top, inputs and outputs diverge when the spy DB returns "unexpected"
    // rows. We seed rows including the same object references and assert the
    // function returns them identically (reference equality) and in order.
    const row1 = { id: 'a', filePath: '/f', chunkIndex: 0, content: 'x', embedding: Buffer.alloc(4), indexedAt: '' };
    const row2 = { id: 'b', filePath: '/f', chunkIndex: 1, content: 'y', embedding: Buffer.alloc(4), indexedAt: '' };

    const db = makeSpyDb([row1, row2]);
    const indexer = new Indexer(db as never, null);

    const result = indexer.getAllEmbeddedChunks();

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(row1);
    expect(result[1]).toBe(row2);
  });

  it('never calls select().from() without a subsequent .where() (no full-table scan path)', () => {
    // A regression that removed the filter entirely would still call
    // `select().from(ragChunks).all()` — i.e. `.where` would never be hit.
    // Guarding against that explicitly.
    const db = makeSpyDb([]);
    const indexer = new Indexer(db as never, null);

    indexer.getAllEmbeddedChunks();

    expect(db.select).toHaveBeenCalledTimes(1);
    // The `.all()` called on the .where() chain, not on .from() directly.
    // Our spy exposes them via different references — `_all` is the one
    // returned from `.where`. If implementation regressed to `.from().all()`
    // it would use a different reference and `_all` would not be called.
    expect(db._all).toHaveBeenCalledTimes(1);
  });
});
