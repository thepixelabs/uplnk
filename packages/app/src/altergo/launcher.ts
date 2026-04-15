import { spawn } from 'node:child_process';

export interface LaunchOptions {
  /** Spawn detached so uplnk can hand back terminal control. Default: true */
  detach?: boolean;
  onExit?: (code: number) => void;
}

/**
 * UPLNK_* env vars that should never leak into child processes.
 * Extend this list if new internal vars are added.
 */
const UPLNK_ENV_PREFIXES = ['UPLNK_'];

/**
 * Build a sanitised copy of the current process environment:
 *   - Strip all UPLNK_* variables so internal state doesn't bleed into the
 *     altergo-managed AI assistant sessions.
 *   - Preserve everything else — PATH, HOME, TERM, etc. all remain intact so
 *     the launched tool works normally.
 */
function sanitiseEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (UPLNK_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Validate that an account or provider name is safe to pass as a CLI argument.
 *
 * We use spawn() with an array of args (never a shell string), so shell
 * injection isn't a risk at the OS level. But we still reject names that
 * contain path traversal sequences or unusual characters so that if altergo
 * itself uses the name as a directory path we don't accidentally point it at
 * something unexpected.
 *
 * Allowed: letters, digits, hyphens, underscores, dots (no leading dot).
 */
function validateArgName(value: string, label: string): void {
  if (value.length === 0) throw new Error(`${label} must not be empty`);
  if (value.startsWith('.'))
    throw new Error(`${label} must not start with a dot: "${value}"`);
  if (!/^[\w.-]+$/.test(value))
    throw new Error(
      `${label} contains invalid characters (allowed: letters, digits, -, _, .): "${value}"`,
    );
}

/**
 * Launch an altergo-managed AI coding assistant account.
 *
 * Security:
 *   - Uses array form of spawn — no shell, no interpolation.
 *   - account and provider are validated before use.
 *   - Internal UPLNK_* env vars are stripped from the child environment.
 *
 * When detach=true (the default): spawns detached with stdio:ignore, calls
 * unref() so the uplnk process can exit independently, and returns
 * immediately.
 *
 * When detach=false: spawns with stdio:inherit so the child takes over the
 * terminal. Blocks until the child exits.
 */
export function launchAltergoAccount(
  binaryPath: string,
  account: string,
  provider?: string,
  opts: LaunchOptions = {},
): void {
  validateArgName(account, 'account');
  if (provider !== undefined) validateArgName(provider, 'provider');

  const { detach = true, onExit } = opts;

  const args: string[] = [account];
  if (provider !== undefined) args.push(provider);

  const child = spawn(binaryPath, args, {
    env: sanitiseEnv(),
    stdio: detach ? 'ignore' : 'inherit',
    detached: detach,
  });

  if (detach) {
    child.unref();
    return;
  }

  if (onExit !== undefined) {
    child.on('exit', (code) => {
      onExit(code ?? 0);
    });
  }
}
