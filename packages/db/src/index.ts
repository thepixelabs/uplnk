export { db, createTestDb, getUplnkDir, getUplnkDbPath, getPylonDir, getPylonDbPath } from './client.js';
export type { Db } from './client.js';
export { runMigrations } from './migrate.js';
export * from './schema.js';
export * from './queries.js';
// Re-export schema-v05 types for forward-compat usage
export type { Project, Role } from './schema-v05.js';
