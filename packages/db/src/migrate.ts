// drizzle-orm does not expose a public API for running pre-bundled migrations.
// dialect.migrate() is the stable internal path used by the migrator package itself.
// The bundledMigrations array is generated at build time by scripts/bundle-migrations.ts
// and committed to the repo so it survives `bun build --compile` (which cannot read
// SQL files from disk at runtime because they are not embedded in the binary VFS).
import { db } from './client.js';
import { bundledMigrations } from './migrations.generated.js';

export function runMigrations(): void {
  // @ts-expect-error — dialect and session are not in the public type surface
  db.dialect.migrate(bundledMigrations, db.session, {});
}
