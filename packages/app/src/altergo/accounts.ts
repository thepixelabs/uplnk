import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface AltergoAccount {
  name: string;
  path: string;
  /** e.g. ['claude-code', 'gemini'] — inferred from which dot-dirs are present */
  providers: string[];
}

/**
 * Map from provider dot-directory name to the canonical provider string used
 * throughout the integration.
 */
const DOT_DIR_TO_PROVIDER: Record<string, string> = {
  '.claude': 'claude-code',
  '.gemini': 'gemini',
  '.codex': 'codex',
  '.copilot': 'copilot',
};

/**
 * List all altergo accounts found under `altergoHome/accounts/`.
 * Each subdirectory is an account; providers are inferred by checking for the
 * known dot-directories inside each account directory.
 *
 * Returns an empty array — never throws — when the accounts directory is
 * absent or unreadable.
 */
export function listAltergoAccounts(altergoHome: string): AltergoAccount[] {
  const accountsDir = join(altergoHome, 'accounts');
  if (!existsSync(accountsDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(accountsDir);
  } catch {
    return [];
  }

  const accounts: AltergoAccount[] = [];

  for (const entry of entries) {
    const accountPath = join(accountsDir, entry);
    try {
      const stat = statSync(accountPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    const providers: string[] = [];
    for (const [dotDir, providerName] of Object.entries(DOT_DIR_TO_PROVIDER)) {
      if (existsSync(join(accountPath, dotDir))) {
        providers.push(providerName);
      }
    }

    accounts.push({ name: entry, path: accountPath, providers });
  }

  return accounts.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Try to read which account is currently active for a given provider from
 * `~/.altergo/state.json` (or the legacy `last_session.json` fallback).
 *
 * Returns null if no state file exists or no match is found. This is purely
 * informational — callers must not depend on it for correctness.
 */
export function getActiveAccount(altergoHome: string, provider: string): string | null {
  const candidates = [
    join(altergoHome, 'state.json'),
    join(altergoHome, 'last_session.json'),
  ];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        // State file may use provider as key or have a flat `account` field
        if (typeof obj[provider] === 'string') return obj[provider] as string;
        if (typeof obj['account'] === 'string') return obj['account'] as string;
      }
    } catch {
      // Malformed state file — skip
    }
  }

  return null;
}
