/**
 * portScan — opt-in discovery of local model servers across common ports.
 *
 * Unlike networkScanner (which probes a fixed (host, port, path) triplet per
 * known server kind), portScan walks a list of commonly-used local ports and
 * tries an OpenAI-compatible `/v1/models` probe at each one. Port 11434 (the
 * Ollama default) falls back to `/api/tags` since Ollama does not implement
 * `/v1/models` on the bare port.
 *
 * Two parallel surfaces are exported:
 *  - `scanLocalEndpoints` — buffered: returns all discovered endpoints at once.
 *  - `scanLocalEndpointsStreaming` — async iterator: yields each endpoint as
 *    soon as its probe lands. Used by the TUI for live UI updates.
 *
 * The scanner never throws. Failed probes (timeout, network error, bad JSON,
 * non-200, malformed shape) are silently dropped. The caller can re-run.
 */

// ─── Public types ─────────────────────────────────────────────────────────────

/** A local model server we successfully reached. */
export interface DiscoveredEndpoint {
  /** Full base URL like 'http://localhost:8000'. */
  url: string;
  /** Port number for sorting / display. */
  port: number;
  /** Best-effort provider kind inferred from response shape + path. */
  kind: 'openai-compat' | 'ollama' | 'llama-cpp' | 'unknown';
  /** Model IDs returned by the discovery probe. */
  models: readonly string[];
  /** Round-trip ms for the discovery probe. */
  latencyMs: number;
}

export interface ScanOptions {
  /** Hosts to scan. Default ['127.0.0.1', 'localhost']. */
  hosts?: readonly string[];
  /** Extra ports beyond the defaults. */
  extraPorts?: readonly number[];
  /** Skip default ports entirely; only scan `extraPorts`. */
  skipDefaults?: boolean;
  /** Per-probe timeout in ms. Default 1500. */
  timeoutMs?: number;
  /** Max parallel probes in-flight at any time. Default 12. */
  concurrency?: number;
  /** Abort the entire scan. Already in-flight probes resolve as misses. */
  signal?: AbortSignal;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

/**
 * Default ports — see plan §4 Tier 3 row 3.7. Note 8080 appears for both
 * llama.cpp and LocalAI; `dedupePorts` collapses duplicates before scanning.
 */
export const DEFAULT_PORTS: readonly number[] = [
  11434, // Ollama
  1234,  // LM Studio default
  8000,  // vLLM / generic OpenAI-compat
  8001,
  8002,
  8003,
  8004,
  8005,
  8080,  // llama.cpp server / LocalAI (same port, different software)
  5000,  // text-generation-webui
  8081,  // LocalAI fallback when 8080 is taken
];

const DEFAULT_HOSTS: readonly string[] = ['127.0.0.1', 'localhost'];
const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_CONCURRENCY = 12;

// ─── Shape parsers ────────────────────────────────────────────────────────────

/**
 * Parse `/v1/models` (OpenAI-compatible) — accepts `{data: [...]}` OR
 * `{models: [...]}` since llama.cpp and a few others emit the latter shape.
 * Returns null for unrecognised shapes.
 */
function parseOpenAIShape(body: unknown): readonly string[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const list = Array.isArray(b['data'])
    ? b['data']
    : Array.isArray(b['models'])
      ? b['models']
      : null;
  if (list === null) return null;
  const ids = (list as Array<{ id?: unknown; name?: unknown }>)
    .map((m) => {
      const id = m.id;
      const name = m.name;
      if (typeof id === 'string' && id.length > 0) return id;
      if (typeof name === 'string' && name.length > 0) return name;
      return '';
    })
    .filter((s) => s.length > 0);
  return ids;
}

/** Parse Ollama `/api/tags` — `{models: [{name: ...}]}`. */
function parseOllamaShape(body: unknown): readonly string[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b['models'])) return null;
  return (b['models'] as Array<{ name?: unknown }>)
    .map((m) => (typeof m.name === 'string' ? m.name : ''))
    .filter((s) => s.length > 0);
}

// ─── Single-candidate probe ───────────────────────────────────────────────────

/**
 * Probe a single (host, port). Tries `/v1/models` first; if that fails AND
 * the port is 11434, tries `/api/tags` (Ollama).
 *
 * Returns null on any failure mode — the caller treats null as "not here".
 */
async function probeOne(
  host: string,
  port: number,
  timeoutMs: number,
  outerSignal: AbortSignal | undefined,
): Promise<DiscoveredEndpoint | null> {
  if (outerSignal?.aborted) return null;

  // Phase 1: OpenAI-compatible /v1/models
  const v1 = await fetchShape(
    `http://${host}:${String(port)}/v1/models`,
    timeoutMs,
    outerSignal,
    parseOpenAIShape,
  );
  if (v1 !== null) {
    return {
      url: `http://${host}:${String(port)}`,
      port,
      kind: 'openai-compat',
      models: v1.models,
      latencyMs: v1.latencyMs,
    };
  }

  // Phase 2: Ollama fallback — only on its well-known port.
  if (port === 11434) {
    if (outerSignal?.aborted) return null;
    const tags = await fetchShape(
      `http://${host}:${String(port)}/api/tags`,
      timeoutMs,
      outerSignal,
      parseOllamaShape,
    );
    if (tags !== null) {
      return {
        url: `http://${host}:${String(port)}`,
        port,
        kind: 'ollama',
        models: tags.models,
        latencyMs: tags.latencyMs,
      };
    }
  }

  return null;
}

/**
 * Fetch + parse a single URL. Caps wall-clock to `timeoutMs` via
 * AbortSignal.timeout; an outer abort signal is honoured if supplied.
 * Returns null on any failure (timeout / network / non-200 / bad JSON / bad shape).
 */
async function fetchShape(
  url: string,
  timeoutMs: number,
  outerSignal: AbortSignal | undefined,
  parse: (body: unknown) => readonly string[] | null,
): Promise<{ models: readonly string[]; latencyMs: number } | null> {
  const started = Date.now();
  try {
    const signal = combineSignals(outerSignal, AbortSignal.timeout(timeoutMs));
    const res = await fetch(url, { signal, redirect: 'error' });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const models = parse(body);
    if (models === null) return null;
    return { models, latencyMs: Date.now() - started };
  } catch {
    // TimeoutError / TypeError / AbortError / JSON parse error → miss.
    return null;
  }
}

/**
 * Returns a signal that aborts when either input aborts. If `outer` is
 * undefined, returns `inner` directly. Uses AbortSignal.any when present;
 * falls back to a manual controller for older runtimes.
 */
function combineSignals(
  outer: AbortSignal | undefined,
  inner: AbortSignal,
): AbortSignal {
  if (outer === undefined) return inner;
  // AbortSignal.any landed in Node 20; fall back manually otherwise.
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn([outer, inner]);
  const ctrl = new AbortController();
  const onOuter = () => ctrl.abort(outer.reason);
  const onInner = () => ctrl.abort(inner.reason);
  if (outer.aborted) ctrl.abort(outer.reason);
  else outer.addEventListener('abort', onOuter, { once: true });
  if (inner.aborted) ctrl.abort(inner.reason);
  else inner.addEventListener('abort', onInner, { once: true });
  return ctrl.signal;
}

// ─── Candidate list construction ──────────────────────────────────────────────

function dedupePorts(ports: readonly number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const p of ports) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

interface Candidate {
  host: string;
  port: number;
}

function buildCandidates(opts: ScanOptions | undefined): Candidate[] {
  const hosts = opts?.hosts ?? DEFAULT_HOSTS;
  const basePorts = opts?.skipDefaults === true ? [] : DEFAULT_PORTS;
  const ports = dedupePorts([...basePorts, ...(opts?.extraPorts ?? [])]);
  const out: Candidate[] = [];
  for (const host of hosts) {
    for (const port of ports) {
      out.push({ host, port });
    }
  }
  return out;
}

// ─── Streaming scan (primary engine) ──────────────────────────────────────────

/**
 * Streaming variant — yields each `DiscoveredEndpoint` as soon as its probe
 * lands. Ordering is best-effort by completion time, NOT by port. UI callers
 * that want port-sorted results should buffer and sort on completion.
 *
 * Concurrency is enforced by a worker pool: exactly `concurrency` workers
 * drain a shared cursor across the candidate array. There is no Promise.race
 * fan-out — we yield via a bounded channel pattern using a Promise queue.
 */
export async function* scanLocalEndpointsStreaming(
  opts?: ScanOptions,
): AsyncGenerator<DiscoveredEndpoint, void, void> {
  const candidates = buildCandidates(opts);
  if (candidates.length === 0) return;

  const concurrency = Math.max(1, opts?.concurrency ?? DEFAULT_CONCURRENCY);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = opts?.signal;

  // Single-slot async queue: workers `push` results, the generator awaits them.
  // We use a manually-managed promise chain because we need backpressure-less
  // yielding (the consumer dictates pacing via its own iteration speed).
  const results: DiscoveredEndpoint[] = [];
  let resolveNext: (() => void) | null = null;
  let done = false;

  const notify = () => {
    const r = resolveNext;
    if (r !== null) {
      resolveNext = null;
      r();
    }
  };

  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) return;
      const i = nextIndex++;
      if (i >= candidates.length) return;
      const c = candidates[i];
      if (c === undefined) return;
      const found = await probeOne(c.host, c.port, timeoutMs, signal);
      if (found !== null) {
        results.push(found);
        notify();
      }
    }
  };

  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < Math.min(concurrency, candidates.length); i++) {
    workers.push(worker());
  }

  const allDone = Promise.all(workers).then(() => {
    done = true;
    notify();
  });

  while (true) {
    if (results.length > 0) {
      const r = results.shift();
      if (r !== undefined) yield r;
      continue;
    }
    if (done) break;
    await new Promise<void>((resolve) => {
      resolveNext = resolve;
    });
  }

  await allDone;
}

// ─── Buffered scan ────────────────────────────────────────────────────────────

/**
 * Scan known/common local model server ports. Returns endpoints that responded
 * to GET `/v1/models` OR (on Ollama's port) `/api/tags`. Result is sorted by
 * port ascending. Never throws; failures are silently dropped.
 */
export async function scanLocalEndpoints(
  opts?: ScanOptions,
): Promise<DiscoveredEndpoint[]> {
  const out: DiscoveredEndpoint[] = [];
  for await (const ep of scanLocalEndpointsStreaming(opts)) {
    out.push(ep);
  }
  out.sort((a, b) => a.port - b.port);
  return out;
}
