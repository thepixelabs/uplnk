/**
 * Self-update mechanism for Uplnk.
 *
 * Checks npm registry for a newer version and offers to update via the same
 * package manager that installed uplnk (npm, yarn, pnpm — detected from the
 * npm_config_user_agent env var).
 *
 * Update check is skipped when:
 *   - UPLNK_NO_UPDATE=1 env var is set
 *   - config.updates.enabled is false
 *   - last check was < 24h ago (throttled via ~/.uplnk/update-check.json)
 *   - running in CI (CI=true env var)
 */

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const execFileAsync = promisify(execFile);

// ─── Types ─────────────────────────────────────────────────────────────────

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
  /** Null when no update available */
  updateCommand: string | null;
}

interface UpdateCheckCache {
  lastChecked: string; // ISO timestamp
  latestVersion: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const CACHE_PATH = join(homedir(), '.uplnk', 'update-check.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const NPM_REGISTRY_TIMEOUT_MS = 3000;

function getCurrentVersion(): string {
  const require = createRequire(import.meta.url);
  const __dir = dirname(fileURLToPath(import.meta.url));
  try {
    // When running as compiled JS, package.json is two levels up (src/lib → app)
    const pkg = require(join(__dir, '..', '..', 'package.json')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    try {
      const pkg = require(join(__dir, '..', '..', '..', 'package.json')) as { version?: string };
      return pkg.version ?? '0.0.0';
    } catch {
      return '0.0.0';
    }
  }
}

function readCache(): UpdateCheckCache | null {
  try {
    const raw = readFileSync(CACHE_PATH, 'utf-8');
    return JSON.parse(raw) as UpdateCheckCache;
  } catch {
    return null;
  }
}

function writeCache(cache: UpdateCheckCache): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
  } catch {
    // Non-fatal — if we can't write the cache, we just re-check next time
  }
}

function isCacheValid(cache: UpdateCheckCache | null): cache is UpdateCheckCache {
  if (cache === null) return false;
  const age = Date.now() - new Date(cache.lastChecked).getTime();
  return age < CHECK_INTERVAL_MS;
}

/** Detect installed package manager from npm_config_user_agent */
function detectPackageManager(): 'npm' | 'yarn' | 'pnpm' {
  const agent = process.env['npm_config_user_agent'] ?? '';
  if (agent.startsWith('pnpm')) return 'pnpm';
  if (agent.startsWith('yarn')) return 'yarn';
  return 'npm';
}

function buildUpdateCommand(packageName: string, pm: 'npm' | 'yarn' | 'pnpm'): string {
  switch (pm) {
    case 'pnpm': return `pnpm add -g ${packageName}`;
    case 'yarn': return `yarn global add ${packageName}`;
    default:     return `npm install -g ${packageName}`;
  }
}

/**
 * Fetch the latest version of a package from the npm registry.
 * Returns null on network error / timeout.
 */
async function fetchLatestVersion(packageName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'npm',
      ['view', packageName, 'version', '--json'],
      { timeout: NPM_REGISTRY_TIMEOUT_MS },
    );
    const parsed: unknown = JSON.parse(stdout.trim());
    if (typeof parsed === 'string') return parsed;
    // npm view can return an array when there are dist-tags
    if (Array.isArray(parsed) && typeof parsed[0] === 'string') return parsed[0] as string;
    return null;
  } catch {
    return null;
  }
}

/** Compare semver strings. Returns true if b > a. */
function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const [aMaj = 0, aMin = 0, aPat = 0] = parse(a);
  const [bMaj = 0, bMin = 0, bPat = 0] = parse(b);
  if (bMaj !== aMaj) return bMaj > aMaj;
  if (bMin !== aMin) return bMin > aMin;
  return bPat > aPat;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Check for a newer version of uplnk on npm.
 *
 * Uses a 24h cache to avoid hammering the registry. Returns null when the
 * check is skipped (CI, disabled, throttled) or when the network is
 * unavailable.
 */
export async function checkForUpdate(opts: {
  packageName: string;
  enabled: boolean;
}): Promise<UpdateCheckResult | null> {
  // Skip in CI or when explicitly disabled
  if (
    !opts.enabled ||
    process.env['UPLNK_NO_UPDATE'] === '1' ||
    process.env['CI'] === 'true'
  ) {
    return null;
  }

  const cache = readCache();
  const currentVersion = getCurrentVersion();
  let latestVersion: string;

  if (isCacheValid(cache)) {
    latestVersion = cache.latestVersion;
  } else {
    const fetched = await fetchLatestVersion(opts.packageName);
    if (fetched === null) return null;
    latestVersion = fetched;
    writeCache({ lastChecked: new Date().toISOString(), latestVersion });
  }

  const updateAvailable = isNewer(currentVersion, latestVersion);
  const pm = detectPackageManager();

  return {
    updateAvailable,
    currentVersion,
    latestVersion,
    updateCommand: updateAvailable ? buildUpdateCommand(opts.packageName, pm) : null,
  };
}

/**
 * Perform the self-update by running the detected package manager.
 * Streams output to the provided write function.
 */
export async function performUpdate(
  packageName: string,
  onOutput: (line: string) => void,
): Promise<void> {
  const pm = detectPackageManager();
  const cmd = buildUpdateCommand(packageName, pm);
  onOutput(`Running: ${cmd}`);

  const [pmCmd, ...pmArgs] = cmd.split(' ');
  await execFileAsync(pmCmd!, pmArgs, { timeout: 120_000 });
  onOutput('Update complete. Restart uplnk to use the new version.');
}
