/**
 * Global test setup for the uplnk-db package.
 *
 * Responsibilities:
 *  1. Provide a `createMigratedDb` helper that creates a fresh `:memory:` SQLite
 *     database and runs all migrations before returning it. Test files import
 *     this helper directly — they do not use the module-level `db` singleton.
 *  2. Ensure each test file starts with a clean database by never sharing the
 *     `:memory:` db instance across test files (Vitest worker isolation handles
 *     this when `isolate: true` is set in the vitest config).
 *
 * Deliberately NOT mocking node:os here:
 *  The uplnk-db package tests exercise real SQLite behaviour using `:memory:`
 *  databases passed explicitly to query functions. The module-level `db`
 *  singleton (which uses the real homedir) is never called in these tests
 *  because all query functions accept a `db` parameter.
 *
 * Deliberately NOT using beforeEach here:
 *  Each test file that needs a fresh DB creates one via `createMigratedDb()`
 *  in its own `beforeEach`. This file only exports the factory helper — it does
 *  not impose a lifecycle on test files that may not need a DB at all.
 */

import { vi, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../client.js';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type { Db } from '../client.js';

// ─── Migration helper ─────────────────────────────────────────────────────────

const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

/**
 * Creates a fresh `:memory:` SQLite database with all migrations applied.
 *
 * Usage in test files:
 *   import { createMigratedDb } from './__tests__/setup.js';
 *   let db: Db;
 *   beforeEach(() => { db = createMigratedDb(); });
 */
export function createMigratedDb(): Db {
  const db = createTestDb(':memory:');
  migrate(db, { migrationsFolder });
  return db;
}

// ─── Mock cleanup between tests ───────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});
