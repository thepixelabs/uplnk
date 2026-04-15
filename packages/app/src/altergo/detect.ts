import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AltergoInfo {
  installed: boolean;
  binaryPath?: string;
  version?: string;
  /** Default: ~/.altergo */
  home: string;
}

/**
 * Detect whether altergo is installed by locating its binary via `which`.
 * Returns a safe "not installed" result if the binary is absent — the rest
 * of the integration degrades gracefully when this returns installed:false.
 *
 * We intentionally do NOT shell-interpolate binaryName — execSync receives
 * it as a string but the value is fully controlled by the caller (defaults
 * to the hardcoded constant 'altergo' in all call sites).
 */
export function detectAltergo(binaryName = 'altergo'): AltergoInfo {
  const home = join(homedir(), '.altergo');
  try {
    // which returns non-zero exit if not found, which throws in execSync
    const binaryPath = execSync(`which ${binaryName}`, {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!binaryPath) return { installed: false, home };

    let version: string | undefined;
    try {
      version = execSync(`${binaryPath} --version`, {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // version is optional — not finding it is not a failure
    }

    return version !== undefined
      ? { installed: true, binaryPath, version, home }
      : { installed: true, binaryPath, home };
  } catch {
    return { installed: false, home };
  }
}

/**
 * Resolve the altergo home directory, expanding a leading `~` to the
 * current user's home. Falls back to `~/.altergo` when nothing is configured.
 */
export function getAltergoHome(configured?: string): string {
  return (configured ?? '~/.altergo').replace(/^~/, homedir());
}
