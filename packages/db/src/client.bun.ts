import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as schema from './schema.js';

export function getUplnkDir(): string {
  return join(homedir(), '.uplnk');
}

/** @deprecated Use getUplnkDir */
export const getUplnkDir = getUplnkDir;

export function getUplnkDbPath(): string {
  const uplnkDir = getUplnkDir();
  mkdirSync(uplnkDir, { recursive: true });
  return join(uplnkDir, 'db.sqlite');
}

/** @deprecated Use getUplnkDbPath */
export const getUplnkDbPath = getUplnkDbPath;

function createDb(dbPath?: string) {
  const sqlite = new Database(dbPath ?? getUplnkDbPath());

  // bun:sqlite exec() is fire-and-forget. Use query().get() for WAL so we can
  // validate the mode was actually accepted — on network filesystems or
  // read-only mounts the pragma silently falls back to 'delete'.
  const row = sqlite.query<{ journal_mode: string }, []>('PRAGMA journal_mode = WAL').get();
  if (row?.journal_mode !== 'wal') {
    process.stderr.write(
      `[uplnk] SQLite WAL mode could not be set (got: ${row?.journal_mode ?? 'unknown'}). ` +
      `Performance may be degraded on network or read-only filesystems.\n`
    );
  }

  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA cache_size = -65536');

  return drizzle(sqlite, { schema });
}

export const db = createDb();
export type Db = typeof db;

/** For tests: in-memory or temp-file database */
export function createTestDb(path = ':memory:'): Db {
  return createDb(path);
}
