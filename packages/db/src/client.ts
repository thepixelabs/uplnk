import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as schema from './schema.js';

export function getPylonDir(): string {
  return join(homedir(), '.pylon');
}

export function getPylonDbPath(): string {
  const pylonDir = getPylonDir();
  mkdirSync(pylonDir, { recursive: true });
  return join(pylonDir, 'db.sqlite');
}

function createDb(dbPath?: string) {
  const sqlite = new Database(dbPath ?? getPylonDbPath());

  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('cache_size = -65536');

  return drizzle(sqlite, { schema });
}

export const db = createDb();
export type Db = typeof db;

/** For tests: in-memory or temp-file database */
export function createTestDb(path = ':memory:'): Db {
  return createDb(path);
}
