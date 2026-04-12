import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from './client.js';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

/** Run pending migrations synchronously before the Ink render loop starts. */
export function runMigrations(): void {
  migrate(db, { migrationsFolder });
}
