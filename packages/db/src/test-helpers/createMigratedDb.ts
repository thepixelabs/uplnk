// Single source of truth for spinning up a migrated `:memory:` SQLite database
// in tests. Runs under Bun (bun:sqlite); identical wiring to production
// runMigrations() in ../migrate.ts so test fidelity matches shipped binary.

import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from '../schema.js';
import { bundledMigrations } from '../migrations.generated.js';
import type { Db } from '../client.js';

export interface MigratedTestDb {
  db: Db;
  sqlite: Database;
  close: () => void;
}

/**
 * Returns the Drizzle Db instance directly. Best for tests that don't need
 * to control the in-memory SQLite handle lifecycle — Bun's GC reclaims the
 * `:memory:` connection when the Db goes out of scope.
 */
export function createMigratedDb(): Db {
  return createMigratedTestDb().db;
}

/**
 * Returns the full handle including a `close()` function. Use when a test
 * needs deterministic cleanup (e.g., `afterEach(() => close())`).
 */
export function createMigratedTestDb(): MigratedTestDb {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const db = drizzle(sqlite, { schema }) as unknown as Db;
  // @ts-expect-error — dialect and session are not in the public type surface
  db.dialect.migrate(bundledMigrations, db.session, {});
  return { db, sqlite, close: () => sqlite.close() };
}
