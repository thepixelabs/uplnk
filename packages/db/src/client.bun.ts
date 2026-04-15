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
export const getPylonDir = getUplnkDir;

export function getUplnkDbPath(): string {
  const uplnkDir = getUplnkDir();
  mkdirSync(uplnkDir, { recursive: true });
  return join(uplnkDir, 'db.sqlite');
}

/** @deprecated Use getUplnkDbPath */
export const getPylonDbPath = getUplnkDbPath;

function createDb(dbPath?: string) {
  const sqlite = new Database(dbPath ?? getUplnkDbPath());

  // bun:sqlite uses exec() instead of better-sqlite3's pragma() helper
  sqlite.exec('PRAGMA journal_mode = WAL');
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
