// Bun-specific barrel used by `bun build --compile`.
// Overrides the db/createTestDb/Db exports with bun:sqlite implementations
// while re-exporting everything else from the standard index.
export { db, createTestDb, getUplnkDir, getUplnkDbPath } from './client.bun.js';
export type { Db } from './client.bun.js';
export { runMigrations } from './migrate.bun.js';
export * from './schema.js';
export * from './queries.js';
// Re-export schema-v05 types for forward-compat usage
export type { Project, Role } from './schema-v05.js';
