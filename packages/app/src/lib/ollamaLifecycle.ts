import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Default base URL for a local Ollama daemon. */
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/** Default network probe timeout (single round-trip). */
export const DEFAULT_PROBE_TIMEOUT_MS = 1_500;

/** Default ceiling on how long we wait for `ollama serve` to become reachable. */
export const DEFAULT_READINESS_TIMEOUT_MS = 8_000;

/** Default delay between readiness polls after spawn. */
export const DEFAULT_POLL_INTERVAL_MS = 250;

/** Default timeout for the `which`/`where` lookup of the ollama binary. */
const WHICH_TIMEOUT_MS = 1_000;

/** Outcome shape for a single HTTP probe against the Ollama daemon. */
export interface OllamaProbeResult {
  reachable: boolean;
  /** Round-trip ms if reachable. */
  latencyMs?: number;
  /** Whether the server returned a valid /api/tags response. */
  validResponse: boolean;
}

/** Result discriminated union for {@link launchOllama}. */
export type OllamaLaunchOutcome =
  | { status: 'started'; pid: number; reachableAfterMs: number }
  | { status: 'already-running' }
  | { status: 'not-installed' }
  | { status: 'launch-failed'; error: string }
  | { status: 'unreachable-after-launch'; pid: number };

/** Options for {@link launchOllama}. */
export interface LaunchOllamaOptions {
  /** URL to probe (default 'http://localhost:11434'). */
  url?: string;
  /** Max ms to wait for the server to come up after launch. Default 8_000. */
  readinessTimeoutMs?: number;
  /** Probe interval during readiness wait. Default 250. */
  pollIntervalMs?: number;
  /** Abort the entire operation. */
  signal?: AbortSignal;
}

/**
 * Issues a single GET against `${url}/api/tags` and reports reachability +
 * whether the response body parses as a model-list object. Never throws.
 */
export async function probeOllama(
  url: string,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<OllamaProbeResult> {
  const controller = new AbortController();
  // Chain caller-provided signal so a parent abort cancels the in-flight fetch.
  const onAbort = (): void => controller.abort();
  if (signal !== undefined) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${stripTrailingSlash(url)}/api/tags`, {
      signal: controller.signal,
      // Avoid keep-alive sockets surviving past the probe — we want a clean
      // socket-level failure to surface fast when the daemon dies.
      headers: { Accept: 'application/json' },
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      // Drain the body so the socket can be reused/closed cleanly.
      await safeConsumeBody(res);
      return { reachable: true, latencyMs, validResponse: false };
    }
    const body = await safeParseJson(res);
    const validResponse = body !== null && typeof body === 'object' && 'models' in body;
    return { reachable: true, latencyMs, validResponse };
  } catch {
    return { reachable: false, validResponse: false };
  } finally {
    clearTimeout(timeoutHandle);
    if (signal !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Attempts to start the Ollama daemon if it isn't already running. See module
 * doc — sequence is: probe → locate binary → detached spawn → poll readiness.
 */
export async function launchOllama(
  opts: LaunchOllamaOptions = {},
): Promise<OllamaLaunchOutcome> {
  const url = opts.url ?? DEFAULT_OLLAMA_URL;
  const readinessTimeoutMs = opts.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const signal = opts.signal;

  throwIfAborted(signal);

  // 1. Already up? Skip the spawn entirely so repeated calls are cheap.
  const initial = await probeOllama(url, signal);
  throwIfAborted(signal);
  if (initial.reachable) {
    return { status: 'already-running' };
  }

  // 2. Locate the binary. `which` first (handles custom PATH installs); then
  //    fall back to per-OS standard install paths.
  const binary = await locateOllamaBinary();
  if (binary === null) {
    return { status: 'not-installed' };
  }

  // 3. Detached spawn — the daemon must outlive uplnk. We ignore stdio so the
  //    Node EventEmitter doesn't keep refs to pipes (which would defeat unref).
  let pid: number;
  try {
    const child = spawn(binary, ['serve'], {
      detached: true,
      stdio: 'ignore',
      // Windows: hide the console window so a TUI user doesn't get a flash.
      windowsHide: true,
    });
    if (typeof child.pid !== 'number') {
      return { status: 'launch-failed', error: 'spawn returned no pid' };
    }
    pid = child.pid;
    // Drop the child reference from our event loop so the uplnk process can
    // exit even though the daemon is still running.
    child.unref();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'launch-failed', error: message };
  }

  // 4. Poll until reachable or readiness timeout.
  const startedAt = Date.now();
  while (Date.now() - startedAt < readinessTimeoutMs) {
    throwIfAborted(signal);
    const result = await probeOllama(url, signal);
    if (result.reachable) {
      return { status: 'started', pid, reachableAfterMs: Date.now() - startedAt };
    }
    await sleep(pollIntervalMs, signal);
  }
  return { status: 'unreachable-after-launch', pid };
}

// ─── Internals ────────────────────────────────────────────────────────────────

/**
 * Walks `which`/`where` then the per-OS fallback list and returns the first
 * existing path, or null if Ollama isn't installed in a known location.
 */
async function locateOllamaBinary(): Promise<string | null> {
  const fromPath = await runWhich();
  if (fromPath !== null && existsSync(fromPath)) return fromPath;

  for (const candidate of fallbackPathsForPlatform(process.platform)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Per-OS install-path search list, in priority order. Visible for tests. */
export function fallbackPathsForPlatform(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return [
      '/usr/local/bin/ollama',
      '/opt/homebrew/bin/ollama',
      join(homedir(), 'Applications/Ollama.app/Contents/Resources/ollama'),
      '/Applications/Ollama.app/Contents/Resources/ollama',
    ];
  }
  if (platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? '';
    const candidates = ['C:\\Program Files\\Ollama\\ollama.exe'];
    if (localAppData !== '') {
      candidates.push(join(localAppData, 'Programs', 'Ollama', 'ollama.exe'));
    }
    return candidates;
  }
  // linux + everything else POSIX-shaped.
  return ['/usr/local/bin/ollama', '/usr/bin/ollama'];
}

/** Runs `which ollama` (or `where ollama` on Windows) and returns the first match. */
async function runWhich(): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return await new Promise<string | null>((resolve) => {
    execFile(cmd, ['ollama'], { timeout: WHICH_TIMEOUT_MS }, (err, stdout) => {
      if (err !== null) {
        resolve(null);
        return;
      }
      const first = stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s !== '');
      resolve(first ?? null);
    });
  });
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

async function safeParseJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function safeConsumeBody(res: Response): Promise<void> {
  try {
    await res.text();
  } catch {
    /* socket already gone — fine. */
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal !== undefined && signal.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    throw new DOMException('Aborted', 'AbortError');
  }
}

/** Promise-sleep that rejects on abort. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      const reason = signal?.reason;
      reject(reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
