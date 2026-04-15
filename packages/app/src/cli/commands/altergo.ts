import { detectAltergo, getAltergoHome } from '../../altergo/detect.js';
import { listAltergoAccounts } from '../../altergo/accounts.js';
import { importAllSessions } from '../../altergo/importer.js';
import { launchAltergoAccount } from '../../altergo/launcher.js';

export interface AltergoCommandOptions {
  action: string;
  args: string[];
}

/**
 * CLI handler for `uplnk altergo <action> [args]`
 *
 * Actions:
 *   list                    — list all accounts and their detected providers
 *   launch <account> [provider] — launch an altergo account session
 *   import <account>        — import all sessions for an account into uplnk DB
 *   import-all              — import all sessions for all accounts
 */
export async function runAltergoCommand(options: AltergoCommandOptions): Promise<void> {
  const { action, args } = options;

  const info = detectAltergo();
  const altergoHome = getAltergoHome();

  switch (action) {
    case 'list': {
      if (!info.installed) {
        process.stderr.write('altergo not found. Install with: pip install altergo\n');
        process.exit(1);
      }
      const accounts = listAltergoAccounts(altergoHome);
      if (accounts.length === 0) {
        process.stdout.write('No accounts found in ~/.altergo/accounts/\n');
        return;
      }
      for (const account of accounts) {
        const providers = account.providers.length > 0 ? account.providers.join(', ') : 'none detected';
        process.stdout.write(`${account.name}  [${providers}]\n`);
      }
      return;
    }

    case 'launch': {
      const account = args[0];
      if (account === undefined || account === '') {
        process.stderr.write('Usage: uplnk altergo launch <account> [provider]\n');
        process.exit(1);
      }
      if (!info.installed || info.binaryPath === undefined) {
        process.stderr.write('altergo not found. Install with: pip install altergo\n');
        process.exit(1);
      }
      const provider = args[1];
      // Non-detached: hand over the terminal entirely
      launchAltergoAccount(info.binaryPath, account, provider, { detach: false });
      return;
    }

    case 'import': {
      const account = args[0];
      if (account === undefined || account === '') {
        process.stderr.write('Usage: uplnk altergo import <account>\n');
        process.exit(1);
      }
      process.stdout.write(`Importing sessions for account "${account}"...\n`);
      const result = await importAllSessions(altergoHome, [account]);
      process.stdout.write(
        `Done: ${String(result.imported)} imported, ${String(result.skipped)} unchanged, ${String(result.errors)} errors\n`,
      );
      return;
    }

    case 'import-all': {
      const accounts = listAltergoAccounts(altergoHome);
      if (accounts.length === 0) {
        process.stdout.write('No accounts found. Nothing to import.\n');
        return;
      }
      const accountNames = accounts.map((a) => a.name);
      process.stdout.write(`Importing sessions for ${String(accountNames.length)} account(s)...\n`);
      const result = await importAllSessions(altergoHome, accountNames);
      process.stdout.write(
        `Done: ${String(result.imported)} imported, ${String(result.skipped)} unchanged, ${String(result.errors)} errors\n`,
      );
      return;
    }

    default: {
      process.stderr.write(
        `Unknown altergo action: "${action}"\n` +
        'Available actions: list, launch, import, import-all\n',
      );
      process.exit(1);
    }
  }
}
