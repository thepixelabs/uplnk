/**
 * MCP Security Layer — Three-layer defense (ref: 11-security-threat-model.md)
 *
 * Layer 1: Tool call validator (this file) — deterministic, synchronous
 * Layer 2: Human-in-the-loop (ApprovalDialog component) — for command-exec
 * Layer 3: OS-level sandboxing — execFile with restricted environment
 *
 * Security principles:
 * - Allowlist, not denylist. Default deny.
 * - Path traversal prevention: resolve all paths to real absolute paths before
 *   comparing against allowedRoots. `path.resolve` alone is insufficient for
 *   symlinks — use `realpathSync` when the path exists.
 * - Credentials blocklist: even within allowed roots, block common secret
 *   file patterns. Defence in depth.
 * - Command exec is feature-flagged OFF by default.
 */

import { resolve, relative, basename } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// ─── Policy types ─────────────────────────────────────────────────────────────

export interface FileAccessPolicy {
  /** Allowlisted root directories. Paths outside these are always denied. */
  allowedRoots: string[];
  /** File/dir name patterns that are always blocked regardless of root. */
  blockedPatterns: RegExp[];
  /** Max bytes for a single file read. Default 1 MiB. */
  maxReadBytes: number;
}

export const DEFAULT_BLOCKED_PATTERNS: RegExp[] = [
  /\.(env|env\.\w+)$/i,           // .env, .env.local, .env.production, etc.
  /credentials(\.json)?$/i,       // AWS credentials, GCP service account keys
  /\.git\/config$/,               // git config (can contain tokens)
  /\.ssh(\/|$)/,                  // SSH keys — matches dir with or without trailing slash
  /\.gnupg(\/|$)/,                // GPG keys — matches dir with or without trailing slash
  /\.aws(\/|$)/,                  // AWS CLI credentials — matches dir with or without trailing slash
  /\.kube(\/|$)/,                 // kubeconfig — matches dir with or without trailing slash
  /\.docker\/config\.json$/,      // Docker credentials
  /id_rsa$|id_ed25519$|id_ecdsa$/, // SSH private keys
  /\.pem$|\.p12$|\.pfx$|\.key$/i, // TLS private keys
  /secrets?\.(json|yaml|yml|toml)$/i, // generic secrets files
  /\.npmrc$/,                     // npm auth tokens
  /\.pypirc$/,                    // PyPI tokens
  /keystore\.(jks|p12)$/i,        // Java keystores
  /wallet\.(dat|json)$/i,         // crypto wallets
];

export function createDefaultPolicy(allowedRoots: string[]): FileAccessPolicy {
  return {
    allowedRoots: allowedRoots.map((r) => resolveReal(r)),
    blockedPatterns: DEFAULT_BLOCKED_PATTERNS,
    maxReadBytes: 1 * 1024 * 1024, // 1 MiB
  };
}

// ─── Validation result ────────────────────────────────────────────────────────

export type ValidationResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Result type specific to validateFilePath.
 * On success it carries the canonical resolved path so callers can use it for
 * all subsequent I/O, closing the TOCTOU window between validation and access.
 */
export type FilePathValidationResult =
  | { allowed: true; resolvedPath: string }
  | { allowed: false; reason: string };

// ─── Path resolution helper ───────────────────────────────────────────────────

/**
 * Attempt to resolve a path to its real absolute path.
 * If the path doesn't exist yet (e.g. a new file), fall back to
 * `path.resolve` (no symlink resolution, but traversal is normalised).
 */
function resolveReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

// ─── File access validator ────────────────────────────────────────────────────

/**
 * Validate a file path against the access policy.
 *
 * Checks, in order:
 * 1. The path is absolute after normalisation.
 * 2. The path is inside at least one allowed root (after resolving symlinks).
 * 3. The path does not match any blocked pattern.
 *
 * Returns { allowed: true } or { allowed: false, reason: '...' }.
 */
export function validateFilePath(
  rawPath: string,
  policy: FileAccessPolicy,
): FilePathValidationResult {
  if (!rawPath || typeof rawPath !== 'string') {
    return { allowed: false, reason: 'Path must be a non-empty string.' };
  }

  const resolved = resolveReal(rawPath);

  // Check against blocked patterns first (quick check)
  for (const pattern of policy.blockedPatterns) {
    if (pattern.test(resolved)) {
      return {
        allowed: false,
        reason: `Access denied: path matches blocked pattern (${pattern.source}).`,
      };
    }
  }

  // Verify the resolved path is inside at least one allowed root
  const inAllowedRoot = policy.allowedRoots.some((root) => {
    const rel = relative(root, resolved);
    // relative() returns a path starting with '..' if target is outside root
    return !rel.startsWith('..') && !resolve(root, rel).startsWith('..');
  });

  if (!inAllowedRoot) {
    return {
      allowed: false,
      reason: `Access denied: path is outside the allowed directories. Allowed: ${policy.allowedRoots.join(', ')}.`,
    };
  }

  return { allowed: true, resolvedPath: resolved };
}

// ─── File size validator ──────────────────────────────────────────────────────

export function validateFileSize(
  filePath: string,
  policy: FileAccessPolicy,
): ValidationResult {
  try {
    const stat = statSync(filePath);
    if (stat.size > policy.maxReadBytes) {
      const mb = (stat.size / (1024 * 1024)).toFixed(1);
      const limitMb = (policy.maxReadBytes / (1024 * 1024)).toFixed(0);
      return {
        allowed: false,
        reason: `File too large: ${mb} MiB (limit: ${limitMb} MiB).`,
      };
    }
    return { allowed: true };
  } catch {
    // If stat fails, the file may not exist or may not be readable — let the
    // actual read operation surface that error.
    return { allowed: true };
  }
}

// ─── Command allowlist constants ──────────────────────────────────────────────

/**
 * Default set of allowed command binaries.
 * These are safe read/query/build tools that the LLM is permitted to invoke.
 * Security takes priority: commands that also appear in NEVER_ALLOW_COMMANDS
 * are always denied regardless of this list.
 */
export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
  'cat', 'ls', 'find', 'grep', 'rg', 'fd', 'awk', 'sed',
  'head', 'tail', 'wc', 'sort', 'uniq', 'diff',
  'git', 'node', 'npm', 'npx', 'pnpm', 'yarn',
  'make', 'cargo', 'go', 'python3', 'ruby',
  'jq', 'curl', 'wget', 'echo', 'printf',
];

/**
 * Permanently blocked binaries — no config override can allow these.
 * Shells, interpreters, network tools, privilege escalation, destructive ops.
 * NEVER_ALLOW takes absolute precedence over DEFAULT_ALLOWED_COMMANDS and
 * any user-supplied additionalAllowed list.
 */
export const NEVER_ALLOW_COMMANDS: ReadonlySet<string> = new Set([
  // Shells
  'sh', 'bash', 'zsh', 'fish', 'csh', 'tcsh', 'ksh', 'dash',
  // Interpreters (generic execution vectors)
  'python', 'python2', 'ruby', 'perl', 'node', 'deno', 'bun',
  'php', 'lua', 'tclsh', 'expect',
  // Automation / scripting
  'osascript', 'powershell', 'pwsh', 'cmd',
  // Network tools
  'nc', 'netcat', 'ncat', 'socat',
  'ssh', 'telnet', 'ftp', 'sftp', 'scp', 'rsync',
  'curl', 'wget',
  // Destructive filesystem
  'rm', 'rmdir', 'dd', 'mkfs', 'fdisk', 'parted', 'shred',
  // Permission / ownership changes
  'chmod', 'chown', 'chgrp',
  // Privilege escalation
  'sudo', 'su', 'doas', 'pkexec', 'install',
  // Scheduling / persistence
  'crontab', 'at', 'batch', 'nohup',
  // Terminal multiplexers / detached processes
  'screen', 'tmux', 'dtach',
]);

/**
 * Trusted directories from which resolved binary paths must originate.
 * Binaries resolving outside these dirs are denied even if their basename
 * is in the allowlist — prevents path-hijacking attacks.
 */
export const ALLOWED_BIN_DIRS: readonly string[] = [
  '/bin',
  '/usr/bin',
  '/usr/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/home/linuxbrew/.linuxbrew/bin',
  '/opt/local/bin',
];

// ─── Command validator ────────────────────────────────────────────────────────

/** Patterns that are unconditionally blocked for command execution */
const BLOCKED_COMMAND_PATTERNS: RegExp[] = [
  /rm\s+-rf?\s+\//,           // rm -rf /
  />\s*\/dev\/(sda|nvme|hd)/, // direct disk write
  /mkfs\b/,                   // format filesystem
  /dd\s+if=/,                 // disk dump
  /fork\s*bomb|\(\s*\)\s*\{/, // fork bombs
  /curl\s+.*\|\s*(bash|sh|zsh|fish)/, // piped remote exec
  /wget\s+.*\|\s*(bash|sh|zsh|fish)/,
  /eval\s+\$\(/,              // eval $(...) pattern
  /xargs\s+rm/,               // xargs rm
];

/**
 * Per-argument blocked patterns (FINDING-002).
 * Each entry is [pattern, description] for human-readable denial reasons.
 * These are checked against individual args, not the joined command string,
 * to catch injection attempts that only surface within a single argument.
 */
const BLOCKED_ARG_PATTERNS: Array<[RegExp, string]> = [
  // Shell metacharacters — dangerous even via execFile when programs
  // re-invoke a shell themselves (e.g. git hooks, make, sh -c wrappers).
  [/;/, 'shell metacharacter ";"'],
  [/&&/, 'shell metacharacter "&&"'],
  [/\|\|/, 'shell metacharacter "||"'],
  [/\|/, 'shell metacharacter "|"'],
  [/>/, 'shell metacharacter ">"'],
  [/`/, 'shell metacharacter "`"'],
  [/\$\(/, 'shell metacharacter "$()"'],
  [/\$\{/, 'shell metacharacter "${}"'],

  // Path traversal in arguments — allow absolute paths but block relative
  // traversal sequences that could escape an intended directory scope.
  [/\.\.\//, 'path traversal sequence "../"'],

  // Null bytes — can truncate argument strings in C implementations.
  // eslint-disable-next-line no-control-regex
  [/\x00/, 'null byte in argument'],

  // Git-specific dangerous flags:
  //   -c  allows arbitrary config injection (e.g. core.hookspath=/tmp/evil)
  //   --upload-pack / --receive-pack / --exec  allow running arbitrary binaries
  [/^-c$/, 'git flag "-c" (arbitrary config injection)'],
  [/^--upload-pack$/, 'git flag "--upload-pack"'],
  [/^--receive-pack$/, 'git flag "--receive-pack"'],
  [/^--exec$/, 'git flag "--exec"'],

  // find-specific dangerous flags: -exec and -execdir spawn arbitrary commands.
  [/^-exec$/, 'find flag "-exec"'],
  [/^-execdir$/, 'find flag "-execdir"'],
];

export interface CommandValidation {
  /** The command to execute */
  command: string;
  /** Arguments — each validated separately */
  args: string[];
  /** Working directory */
  cwd?: string;
}

/**
 * Validate each argument in `args` against the per-argument blocked pattern
 * list (FINDING-002). Returns the first violation found, or { allowed: true }
 * when all arguments are clean.
 *
 * This is intentionally separate from the full-command pattern check in
 * `validateCommand` so it can be unit-tested in isolation and re-used.
 */
export function validateCommandArgs(
  command: string,
  args: string[],
): ValidationResult {
  for (const [i, arg] of args.entries()) {
    for (const [pattern, description] of BLOCKED_ARG_PATTERNS) {
      if (pattern.test(arg)) {
        return {
          allowed: false,
          reason: `Argument ${i} to "${command}" blocked: contains ${description}.`,
        };
      }
    }
  }
  return { allowed: true };
}

/**
 * Resolve a command binary name to its absolute path.
 * First tries `which`; if that fails (e.g. shell builtins like echo/printf
 * that also have standalone binaries), falls back to scanning ALLOWED_BIN_DIRS
 * directly. Returns the trimmed path on success, or null if not found.
 */
function resolveCommandPath(command: string): string | null {
  // Try `which` first — finds the binary on the user's PATH
  try {
    const result = execFileSync('which', [command], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = result.trim();
    if (trimmed.length > 0) return trimmed;
  } catch {
    // fall through to manual search
  }

  // Fallback: scan ALLOWED_BIN_DIRS for standalone binary.
  // Handles shell builtins (echo, printf) that also exist as standalone
  // binaries (e.g. /bin/echo) but are not found by `which` in some shells.
  for (const dir of ALLOWED_BIN_DIRS) {
    const candidate = `${dir}/${command}`;
    try {
      statSync(candidate);
      return candidate;
    } catch {
      // not found in this dir
    }
  }

  return null;
}

export function validateCommand(
  cmd: CommandValidation,
  policy: FileAccessPolicy,
  additionalAllowed?: string[],
): ValidationResult {
  // Extract the binary basename (handles both bare names and absolute paths)
  const cmdBasename = basename(cmd.command);

  // Step (a): NEVER_ALLOW check — absolute precedence, checked before everything else
  if (NEVER_ALLOW_COMMANDS.has(cmdBasename)) {
    return {
      allowed: false,
      reason: `Command "${cmdBasename}" is permanently blocked by security policy and cannot be allowed.`,
    };
  }

  const fullCommand = [cmd.command, ...cmd.args].join(' ');

  // Check unconditionally blocked patterns on the full command string
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(fullCommand)) {
      return {
        allowed: false,
        reason: `Command blocked by security policy: matches dangerous pattern (${pattern.source}).`,
      };
    }
  }

  // Step (b): Allowlist check — basename must be in DEFAULT_ALLOWED_COMMANDS or additionalAllowed
  // NEVER_ALLOW takes precedence: remove any NEVER_ALLOW entries from the effective set
  const allowedSet = new Set<string>([
    ...DEFAULT_ALLOWED_COMMANDS,
    ...(additionalAllowed ?? []),
  ]);
  for (const blocked of NEVER_ALLOW_COMMANDS) {
    allowedSet.delete(blocked);
  }

  if (!allowedSet.has(cmdBasename)) {
    return {
      allowed: false,
      reason: `Command "${cmdBasename}" is not in the allowed command list.`,
    };
  }

  // Step (c): Absolute path resolution via `which` — deny if not found on PATH
  const resolvedPath = resolveCommandPath(cmdBasename);
  if (resolvedPath === null) {
    return {
      allowed: false,
      reason: `Command "${cmdBasename}" could not be resolved on PATH — binary not found.`,
    };
  }

  // Step (d): Bin dir check — resolved path must start with a trusted bin dir
  const inAllowedBinDir = ALLOWED_BIN_DIRS.some(
    (dir) => resolvedPath.startsWith(dir + '/') || resolvedPath === dir,
  );
  if (!inAllowedBinDir) {
    return {
      allowed: false,
      reason: `Command "${cmdBasename}" resolves to "${resolvedPath}" which is outside the allowed binary directories (${ALLOWED_BIN_DIRS.join(', ')}).`,
    };
  }

  // Per-argument metacharacter/injection validation (FINDING-002)
  const argsResult = validateCommandArgs(cmd.command, cmd.args);
  if (!argsResult.allowed) {
    return argsResult;
  }

  // Validate working directory if specified
  if (cmd.cwd !== undefined) {
    const cwdValidation = validateFilePath(cmd.cwd, policy);
    if (!cwdValidation.allowed) {
      return {
        allowed: false,
        reason: `Working directory not allowed: ${cwdValidation.reason}`,
      };
    }
  }

  // Command passes validation — still requires human approval (Layer 2)
  return { allowed: true };
}
