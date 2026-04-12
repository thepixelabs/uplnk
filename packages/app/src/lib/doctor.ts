import chalk from 'chalk';
import { accessSync, constants } from 'node:fs';
import { getPylonDir, getPylonDbPath } from 'pylon-db';

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
