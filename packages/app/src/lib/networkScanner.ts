import { networkInterfaces, hostname } from 'node:os';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DiscoveredServerKind =
  | 'ollama'
  | 'lmstudio'
  | 'vllm'
  | 'llamacpp'
  | 'localai'
  | 'openwebui';

export interface DiscoveredServer {
  /** Stable identity: `${kind}@${host}:${port}` */
  id: string;
  kind: DiscoveredServerKind;
  host: string;
  port: number;
  /** Canonical base URL: `http://${host}:${port}` */
  url: string;
  latencyMs: number;
  /** Up to 5 model ids from the server */
  models: string[];
  version?: string;
  discoveredAt: string;
}

export interface ScanOptions {
  scope: 'localhost' | 'subnet';
  /** Milliseconds per probe. Default: 1500 */
  timeoutMs?: number;
  /** Max concurrent probes. Default: 32 */
  concurrency?: number;
  /** Called as each server is discovered, before the final result. */
  onResult?: (server: DiscoveredServer) => void;
  signal?: AbortSignal;
  /**
   * Required when scope='subnet'. Must be an ISO 8601 timestamp from
   * config.networkScanner.subnetConfirmedAt. scanNetwork() refuses to
   * perform a subnet scan when this value is absent, mirroring the
   * commandExecConfirmedAt security pattern: a silently-dropped config
   * file cannot widen scan scope.
   */
  subnetConfirmedAt?: string;
}

export interface ScanResult {
  servers: DiscoveredServer[];
  hostsProbed: number;
  durationMs: number;
}

// ─── Probe definitions ────────────────────────────────────────────────────────

interface ProbeDef {
  kind: DiscoveredServerKind;
  port: number;
  path: string;
  parseResponse: (body: unknown) => { models: string[]; version?: string } | null;
}

/**
 * Parse an OpenAI-compatible `/v1/models` response body.
 * Returns null for any unexpected shape so callers can treat it as a miss.
 *
 * Exported for unit-testing the parse logic in isolation.
 */
export function parseOpenAIModels(body: unknown): { models: string[] } | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b['data'])) return null;
  const models = (b['data'] as Array<{ id?: string }>)
    .map((m) => m.id ?? '')
    .filter(Boolean)
    .slice(0, 5);
  return { models };
}

/**
 * Parse an Ollama `/api/tags` response body.
 * Returns null for any unexpected shape so callers can treat it as a miss.
 *
 * Exported for unit-testing the parse logic in isolation.
 */
export function parseOllamaTags(body: unknown): { models: string[] } | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b['models'])) return null;
  const models = (b['models'] as Array<{ name?: string }>)
    .map((m) => m.name ?? '')
    .filter(Boolean)
    .slice(0, 5);
  return { models };
}

const PROBE_DEFS: ProbeDef[] = [
  {
    kind: 'ollama',
    port: 11434,
    path: '/api/tags',
    parseResponse: parseOllamaTags,
  },
  {
    kind: 'lmstudio',
    port: 1234,
    path: '/v1/models',
    parseResponse: parseOpenAIModels,
  },
  {
    kind: 'vllm',
    port: 8000,
    path: '/v1/models',
    parseResponse: parseOpenAIModels,
  },
  {
    kind: 'llamacpp',
    port: 8080,
    path: '/v1/models',
    parseResponse: parseOpenAIModels,
  },
  {
    kind: 'localai',
    // 8081 avoids conflict with llamacpp on 8080 — common LocalAI default
    port: 8081,
    path: '/v1/models',
    parseResponse: parseOpenAIModels,
  },
  {
    kind: 'openwebui',
    port: 3000,
    path: '/api/models',
    parseResponse: (body) => {
      if (typeof body !== 'object' || body === null) return null;
      const b = body as Record<string, unknown>;
      // OpenWebUI returns {data: [{id: "..."}]} OR {models: [...]}
      const list = Array.isArray(b['data'])
        ? b['data']
        : Array.isArray(b['models'])
          ? b['models']
          : null;
      if (!list) return null;
      const models = (list as Array<{ id?: string; name?: string }>)
        .map((m) => m.id ?? m.name ?? '')
        .filter(Boolean)
        .slice(0, 5);
      return { models };
    },
  },
];

// ─── Security helpers ─────────────────────────────────────────────────────────

/**
 * Returns true for addresses in the RFC 1918 private ranges:
 *   10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 *
 * We refuse to scan subnets outside these ranges to prevent the scanner
 * from being used as an SSRF vector against non-local infrastructure.
 */
function isRFC1918(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

// ─── Host enumeration ─────────────────────────────────────────────────────────

/** Maximum total hosts the scanner will probe in a single run. */
const MAX_HOSTS = 512;

/**
 * Returns the set of all IP addresses and hostnames that refer to the
 * local machine. Used for de-duplicating results (e.g. preferring
 * 'localhost' over '127.0.0.1' or a local interface IP).
 */
export function getLocalMachineAddresses(): Set<string> {
  const addrs = new Set<string>(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);
  const name = hostname();
  if (name) {
    addrs.add(name);
    addrs.add(`${name}.local`);
  }

  const ifaces = networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface ?? []) {
      addrs.add(addr.address);
    }
  }
  return addrs;
}

/**
 * Returns the list of hosts to probe based on `scope`.
 *
 * For 'localhost': only loopback addresses + current hostname.
 * For 'subnet': localhost + the /24 derived from the primary RFC 1918 interface.
 *
 * Security guarantees:
 *  - Subnet scanning is limited to RFC 1918 ranges only.
 *  - Only /24 or narrower prefixes are expanded (no /8 sweeps).
 *  - Total host count is hard-capped at MAX_HOSTS (512).
 */
export function getLocalSubnetHosts(scope: 'localhost' | 'subnet'): string[] {
  const hosts: string[] = ['localhost', '127.0.0.1'];

  const name = hostname();
  if (name) {
    if (!hosts.includes(name)) hosts.push(name);
    const localName = `${name}.local`;
    if (!hosts.includes(localName)) hosts.push(localName);
  }

  if (scope === 'localhost') return hosts;

  const ifaces = networkInterfaces();

  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (!addr.cidr) continue;

      // Safety: only scan /16 or narrower — refuse larger subnets (like /8)
      // to avoid massive sweeps. Even for /16, we only sweep the local /24.
      const prefix = Number(addr.cidr.split('/')[1]);
      if (isNaN(prefix) || prefix < 16) continue;

      // Refuse to scan non-RFC1918 addresses (e.g. a cloud VM's public IP)
      if (!isRFC1918(addr.address)) continue;

      const base = addr.address.split('.').slice(0, 3).join('.');
      for (let i = 1; i <= 254; i++) {
        const ip = `${base}.${i}`;
        if (!hosts.includes(ip)) {
          hosts.push(ip);
          // Hard cap — never exceed MAX_HOSTS total
          if (hosts.length >= MAX_HOSTS) return hosts;
        }
      }
    }
  }

  return hosts;
}

// ─── Probe execution ──────────────────────────────────────────────────────────

/**
 * Attempt to contact a single (host, port, path) endpoint.
 *
 * Uses `redirect: 'error'` so we never silently follow a redirect to an
 * unintended target. Returns null on any failure (timeout, non-200, bad JSON,
 * parse miss) — the caller treats null as "not found here".
 */
async function probe(
  host: string,
  def: ProbeDef,
  timeoutMs: number,
): Promise<DiscoveredServer | null> {
  const url = `http://${host}:${def.port}${def.path}`;
  const start = Date.now();

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });

    const latencyMs = Date.now() - start;

    if (!res.ok) return null;

    const body: unknown = await res.json();
    const parsed = def.parseResponse(body);
    if (parsed === null) return null;

    return {
      id: `${def.kind}@${host}:${def.port}`,
      kind: def.kind,
      host,
      port: def.port,
      url: `http://${host}:${def.port}`,
      latencyMs,
      models: parsed.models,
      ...(parsed.version !== undefined ? { version: parsed.version } : {}),
      discoveredAt: new Date().toISOString(),
    };
  } catch {
    // TimeoutError, TypeError (network), redirect error — all treated as a miss
    return null;
  }
}

// ─── Concurrency limiter ──────────────────────────────────────────────────────

/**
 * Run an array of async tasks with at most `limit` running at once.
 *
 * Implemented as a promise-based semaphore without any external dependencies.
 * Results are returned in the same order as `tasks` (parallel, not sequential).
 *
 * Individual task failures are not propagated — tasks are expected to return
 * null on failure rather than throwing. If a task does throw, the error
 * bubbles up naturally (Promise.all semantics).
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      const task = tasks[index];
      if (task === undefined) break;
      results[index] = await task();
    }
  }

  // Spawn `limit` concurrent workers; each drains from the shared `nextIndex`
  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < Math.min(limit, tasks.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return results;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Scan the local machine (and optionally the /24 subnet) for running AI
 * inference servers.
 *
 * Results are streamed via `opts.onResult` as each server is discovered.
 * The returned `ScanResult` contains the same servers in discovery order.
 *
 * Cancellation: pass an `AbortSignal` in `opts.signal`. When aborted,
 * already-started probes are allowed to time out naturally (HTTP fetch
 * cancellation is best-effort), but no new probes are started and the
 * function returns immediately with whatever was found so far.
 */
export async function scanNetwork(opts: ScanOptions): Promise<ScanResult> {
  // ── Subnet consent gate ────────────────────────────────────────────────────
  // A subnet scan touches up to 512 hosts on the local network. Require an
  // explicit ISO timestamp token (written by `uplnk config --confirm-subnet`)
  // so a silently-dropped or maliciously-modified config file cannot widen
  // scan scope without user knowledge.
  if (opts.scope === 'subnet') {
    if (
      typeof opts.subnetConfirmedAt !== 'string' ||
      opts.subnetConfirmedAt.trim() === '' ||
      isNaN(Date.parse(opts.subnetConfirmedAt))
    ) {
      throw new Error(
        'Subnet scanning requires explicit user consent. ' +
        'Run `uplnk config --confirm-subnet` to enable it.',
      );
    }
  }

  const timeoutMs = opts.timeoutMs ?? 1500;
  const concurrency = opts.concurrency ?? 32;
  const signal = opts.signal;

  const hosts = getLocalSubnetHosts(opts.scope);
  const hostsProbed = hosts.length;

  const localAddrs = getLocalMachineAddresses();

  /**
   * Track unique servers by canonical ID to prevent duplicates
   * (e.g. localhost vs 127.0.0.1 vs local IP).
   */
  const discoveredMap = new Map<string, DiscoveredServer>();

  // Build the full (host × probeDef) task list up front so the concurrency
  // limiter can drain them in order. Each task is a closure capturing
  // host + def so the flat list is self-contained.
  const tasks: Array<() => Promise<DiscoveredServer | null>> = [];

  for (const host of hosts) {
    for (const def of PROBE_DEFS) {
      tasks.push(async () => {
        // Check cancellation before starting each probe — avoids flooding
        // the network after the caller has already given up.
        if (signal?.aborted) return null;
        return probe(host, def, timeoutMs);
      });
    }
  }

  const startTime = Date.now();

  // Wrap each task to call onResult eagerly when a server is found
  const wrappedTasks = tasks.map((task) => async (): Promise<DiscoveredServer | null> => {
    if (signal?.aborted) return null;
    const result = await task();
    if (result !== null) {
      // Canonicalize host: if it's local to this machine, use 'localhost'
      // to ensure a stable ID and de-duplicate.
      const isLocal = localAddrs.has(result.host);
      const canonicalHost = isLocal ? 'localhost' : result.host;
      const canonicalId = `${result.kind}@${canonicalHost}:${result.port}`;

      if (!discoveredMap.has(canonicalId)) {
        // If we de-duplicated a local IP to localhost, update the record
        if (isLocal && result.host !== 'localhost') {
          result.host = 'localhost';
          result.url = `http://localhost:${result.port}`;
          result.id = canonicalId;
        }

        discoveredMap.set(canonicalId, result);
        opts.onResult?.(result);
      }
    }
    return result;
  });

  await runWithConcurrency(wrappedTasks, concurrency);

  return {
    servers: Array.from(discoveredMap.values()),
    hostsProbed,
    durationMs: Date.now() - startTime,
  };
}
