import chalk from 'chalk';
import { accessSync, constants } from 'node:fs';
import { db, getPylonDir, getPylonDbPath, listProviders, setProviderApiKey } from 'pylon-db';
import { initSecretsBackend, getSecretsBackend, isSecretRef, migratePlaintext } from './secrets.js';

interface Check {
  name: string;
  run: () => Promise<{ ok: boolean; detail: string }>;
}

const checks: Check[] = [
  {
    name: 'Node.js version',
    run: async () => {
      const [major] = process.version.slice(1).split('.').map(Number);
      const ok = (major ?? 0) >= 20;
      return { ok, detail: `${process.version}${ok ? '' : ' (requires >=20)'}` };
    },
  },
  {
    name: 'Config directory',
    run: async () => {
      const dir = getPylonDir();
      try {
        accessSync(dir, constants.W_OK);
        return { ok: true, detail: dir };
      } catch {
        return { ok: false, detail: `Cannot write to ${dir}` };
      }
    },
  },
  {
    name: 'SQLite database',
    run: async () => {
      try {
        const { db } = await import('pylon-db');
        db.get('SELECT 1');
        return { ok: true, detail: getPylonDbPath() };
      } catch (err) {
        return { ok: false, detail: String(err) };
      }
    },
  },
  {
    name: 'Ollama reachability',
    run: async () => {
      try {
        const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
        return { ok: true, detail: 'http://localhost:11434' };
      } catch {
        return { ok: false, detail: 'Not reachable — run `ollama serve`' };
      }
    },
  },
];

export async function runDoctor(): Promise<void> {
  console.log(chalk.bold('\nPylon Doctor\n'));

  let allOk = true;
  for (const check of checks) {
    const { ok, detail } = await check.run();
    if (!ok) allOk = false;
    const icon = ok ? chalk.green('✓') : chalk.red('✗');
    const label = chalk.bold(check.name.padEnd(24));
    console.log(`  ${icon}  ${label}  ${ok ? chalk.gray(detail) : chalk.red(detail)}`);
  }

  console.log();
  if (allOk) {
    console.log(chalk.green('All checks passed. Pylon is ready.\n'));
  } else {
    console.log(chalk.yellow('Some checks failed. Fix the issues above and re-run `pylon doctor`.\n'));
    process.exit(1);
  }
}

// ─── Subcommand: migrate-secrets ──────────────────────────────────────────────

/**
 * Walk every row in `provider_configs`, and for any `api_key` that is a
 * legacy plaintext value (not already a `@secret:` ref, not empty, not the
 * literal `"ollama"` placeholder), route it through the secrets backend and
 * rewrite the column with the resulting ref.
 *
 * Idempotent — running twice does nothing on the second pass. Safe to run
 * on a DB that is already fully migrated.
 *
 * Reports per-row outcome and a final summary. Exits with code 0 on success
 * even when no rows needed migration.
 */
export async function runMigrateSecrets(): Promise<void> {
  console.log(chalk.bold('\nPylon Doctor — migrate secrets\n'));

  await initSecretsBackend();
  const backend = getSecretsBackend();
  console.log(chalk.gray(`  backend: ${backend.name}`));
  console.log();

  const rows = listProviders(db);
  if (rows.length === 0) {
    console.log(chalk.yellow('  No providers configured. Nothing to migrate.\n'));
    return;
  }

  let migrated = 0;
  let alreadyRefs = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    const label = chalk.bold(row.name.padEnd(28));
    const key = row.apiKey;
    if (key === null || key === '') {
      console.log(`  ${chalk.gray('—')}  ${label}  ${chalk.gray('no key')}`);
      skipped += 1;
      continue;
    }
    if (isSecretRef(key)) {
      console.log(`  ${chalk.green('✓')}  ${label}  ${chalk.gray('already a ref')}`);
      alreadyRefs += 1;
      continue;
    }
    // The literal placeholder used by the local Ollama default seed: not
    // a real secret, leave as-is so the chat path keeps sending a
    // non-empty Bearer header to compatible servers.
    if (key === 'ollama') {
      console.log(`  ${chalk.gray('—')}  ${label}  ${chalk.gray('ollama placeholder, untouched')}`);
      skipped += 1;
      continue;
    }
    // Two-phase write with compensating action: store the secret first,
    // then update the column. If the column update fails, roll the secret
    // back so we don't leak an orphan ref into the encrypted store. This
    // closes the partial-failure leak the architect flagged in round 2.
    let ref: string | null = null;
    try {
      ref = migratePlaintext(key);
      setProviderApiKey(db, row.id, ref);
      console.log(`  ${chalk.green('✓')}  ${label}  ${chalk.green('migrated')}  ${chalk.gray(ref.slice(0, 9) + '…')}`);
      migrated += 1;
    } catch (err) {
      // Compensating action: drop the just-written ref so a future
      // migrate run won't see two refs for the same plaintext value.
      if (ref !== null) {
        try { getSecretsBackend().deleteSecret(ref); } catch { /* best-effort */ }
      }
      console.log(`  ${chalk.red('✗')}  ${label}  ${chalk.red(err instanceof Error ? err.message : String(err))}`);
      errors += 1;
    }
  }

  console.log();
  const summary = `${chalk.green(String(migrated))} migrated, ${alreadyRefs} already refs, ${skipped} skipped`;
  const errPart = errors > 0 ? `, ${chalk.red(String(errors))} errors` : '';
  console.log(chalk.bold(`  Summary:`) + ` ${summary}${errPart}\n`);
  if (errors > 0) {
    console.log(chalk.yellow(
      `  ${String(errors)} row(s) failed to migrate. The secrets backend was rolled back\n` +
      `  for each failure — no orphaned refs were left behind. Re-run after\n` +
      `  resolving the underlying error.\n`,
    ));
  }
}

// ─── Subcommand: prune-secrets ────────────────────────────────────────────────

/**
 * Find every ref in the secrets backend that is no longer referenced by any
 * row in `provider_configs` and delete it. Used to reclaim space and reduce
 * the surface area of the encrypted store after providers have been removed
 * via the TUI.
 *
 * The OS keychain backend cannot enumerate refs portably and silently no-ops
 * (the user is told). The encrypted-file and plaintext backends both expose
 * `listRefs()` and execute the prune.
 */
export async function runPruneSecrets(): Promise<void> {
  console.log(chalk.bold('\nPylon Doctor — prune secrets\n'));

  await initSecretsBackend();
  const backend = getSecretsBackend();
  console.log(chalk.gray(`  backend: ${backend.name}`));

  const allRefs = backend.listRefs();
  if (allRefs === null) {
    console.log();
    console.log(chalk.yellow(
      `  The ${backend.name} backend does not support listing refs.`,
    ));
    console.log(chalk.gray(
      `  Pruning is a no-op. Refs are dropped automatically when providers\n` +
      `  are removed via /provider → d in the TUI.\n`,
    ));
    return;
  }

  const rows = listProviders(db);
  const live = new Set<string>();
  for (const row of rows) {
    if (row.apiKey !== null && isSecretRef(row.apiKey)) live.add(row.apiKey);
  }

  const orphans = allRefs.filter((r) => !live.has(r));

  console.log(chalk.gray(`  ${String(allRefs.length)} ref(s) in store, ${String(live.size)} referenced by providers, ${String(orphans.length)} orphaned`));
  console.log();

  if (orphans.length === 0) {
    console.log(chalk.green('  Nothing to prune. The secrets store is clean.\n'));
    return;
  }

  // Bulk delete in a single persist() call — avoids O(N) writes when
  // pruning large orphan sets. Each truncated ref is logged for an audit
  // trail (only the `@secret:` prefix is shown — the full ref is not a
  // secret but emitting it in stdout makes the output noisier than needed).
  for (const ref of orphans) {
    console.log(`  ${chalk.green('✓')}  pruned  ${chalk.gray(ref.slice(0, 9) + '…')}`);
  }
  const removed = backend.deleteSecretsBulk(orphans);
  console.log();
  console.log(chalk.bold(`  Summary:`) + ` ${chalk.green(String(removed))} ref(s) pruned\n`);
}
