/**
 * portScan unit tests.
 *
 * Strategy:
 *  - All tests stub global `fetch` via `vi.stubGlobal('fetch', ...)`.
 *  - The mock decides per-URL whether to return a success payload, a 404, a
 *    malformed body, or a never-resolving promise (for timeout / concurrency
 *    tests). No real network I/O ever happens.
 *  - Concurrency caps are verified via a manual in-flight counter that the
 *    mock fetch increments on entry and decrements on resolve.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  scanLocalEndpoints,
  scanLocalEndpointsStreaming,
  DEFAULT_PORTS,
  type DiscoveredEndpoint,
} from '../portScan.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface MockResponse {
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
}

function jsonResponse(body: unknown, ok = true, status = 200): MockResponse {
  return {
    ok,
    status,
    json: async () => body,
  };
}

function makeRouter(
  handlers: Record<string, () => Promise<MockResponse> | MockResponse>,
): (input: Request | string | URL) => Promise<MockResponse> {
  return async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    const h = handlers[url];
    if (h !== undefined) return await h();
    throw new TypeError(`refused: ${url}`);
  };
}

function stubFetch(impl: (input: Request | string | URL, init?: RequestInit) => Promise<MockResponse>): void {
  vi.stubGlobal('fetch', vi.fn(impl as unknown as typeof fetch));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('scanLocalEndpoints — discovery', () => {
  it('returns endpoints sorted by port ascending', async () => {
    stubFetch(
      makeRouter({
        // Three out of N candidates respond — port 1234 (LM Studio),
        // 8000 (vLLM), 8080 (llama.cpp shape).
        'http://127.0.0.1:1234/v1/models': () =>
          jsonResponse({ data: [{ id: 'lmstudio-model' }] }),
        'http://127.0.0.1:8000/v1/models': () =>
          jsonResponse({ data: [{ id: 'vllm-a' }, { id: 'vllm-b' }] }),
        'http://127.0.0.1:8080/v1/models': () =>
          jsonResponse({ data: [{ id: 'llamacpp-model' }] }),
      }),
    );

    const results = await scanLocalEndpoints({
      hosts: ['127.0.0.1'],
      timeoutMs: 50,
    });

    expect(results.map((r) => r.port)).toEqual([1234, 8000, 8080]);
    expect(results[0]?.models).toEqual(['lmstudio-model']);
    expect(results[1]?.models).toEqual(['vllm-a', 'vllm-b']);
    // All three matched on /v1/models, so kind is openai-compat.
    expect(results.every((r) => r.kind === 'openai-compat')).toBe(true);
  });

  it('returns [] when all probes fail (no throw)', async () => {
    stubFetch(async () => {
      throw new TypeError('Network error');
    });
    const results = await scanLocalEndpoints({ hosts: ['127.0.0.1'], timeoutMs: 20 });
    expect(results).toEqual([]);
  });

  it('returns [] when /v1/models returns 500', async () => {
    stubFetch(async () => jsonResponse({}, false, 500));
    const results = await scanLocalEndpoints({ hosts: ['127.0.0.1'], timeoutMs: 20 });
    expect(results).toEqual([]);
  });

  it('drops candidates that return malformed JSON', async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('not JSON');
      },
    }));
    const results = await scanLocalEndpoints({ hosts: ['127.0.0.1'], timeoutMs: 20 });
    expect(results).toEqual([]);
  });
});

// ─── Ollama special-case ──────────────────────────────────────────────────────

describe('scanLocalEndpoints — Ollama fallback', () => {
  it('falls back to /api/tags on port 11434 when /v1/models fails', async () => {
    stubFetch(
      makeRouter({
        'http://127.0.0.1:11434/api/tags': () =>
          jsonResponse({ models: [{ name: 'llama3.2:3b' }, { name: 'qwen2.5:7b' }] }),
      }),
    );
    const results = await scanLocalEndpoints({
      hosts: ['127.0.0.1'],
      timeoutMs: 50,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.kind).toBe('ollama');
    expect(results[0]?.port).toBe(11434);
    expect(results[0]?.models).toEqual(['llama3.2:3b', 'qwen2.5:7b']);
  });

  it('non-Ollama port that responds to /v1/models is labelled openai-compat', async () => {
    stubFetch(
      makeRouter({
        'http://127.0.0.1:8000/v1/models': () =>
          jsonResponse({ data: [{ id: 'm1' }] }),
      }),
    );
    const results = await scanLocalEndpoints({ hosts: ['127.0.0.1'], timeoutMs: 50 });
    expect(results).toHaveLength(1);
    expect(results[0]?.kind).toBe('openai-compat');
  });

  it('does NOT try /api/tags on non-Ollama ports', async () => {
    const calls: string[] = [];
    stubFetch(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      throw new TypeError('refused');
    });
    await scanLocalEndpoints({ hosts: ['127.0.0.1'], timeoutMs: 20 });
    // No URL ending in /api/tags should appear on a non-11434 port.
    const apiTagsCalls = calls.filter((u) => u.endsWith('/api/tags'));
    expect(apiTagsCalls.every((u) => u.includes(':11434/'))).toBe(true);
  });
});

// ─── Port-list construction ───────────────────────────────────────────────────

describe('scanLocalEndpoints — candidate list', () => {
  it('skipDefaults + extraPorts scans only extraPorts', async () => {
    const calls: string[] = [];
    stubFetch(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      throw new TypeError('refused');
    });
    await scanLocalEndpoints({
      hosts: ['127.0.0.1'],
      skipDefaults: true,
      extraPorts: [9999, 9998],
      timeoutMs: 20,
    });
    const ports = new Set(calls.map((u) => Number(u.split(':')[2]?.split('/')[0])));
    expect(ports).toEqual(new Set([9999, 9998]));
  });

  it('deduplicates ports — duplicates in DEFAULT_PORTS or extras only probed once per host', async () => {
    const calls: string[] = [];
    stubFetch(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      throw new TypeError('refused');
    });
    await scanLocalEndpoints({
      hosts: ['127.0.0.1'],
      // 8080 already in defaults; adding it again must not double-probe.
      extraPorts: [8080, 8080, 8080],
      timeoutMs: 20,
    });
    const port8080Calls = calls.filter((u) => u.startsWith('http://127.0.0.1:8080/v1/models'));
    expect(port8080Calls.length).toBe(1);
  });

  it('Cartesian product of hosts × ports — N hosts probed for each port', async () => {
    const calls: string[] = [];
    stubFetch(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      throw new TypeError('refused');
    });
    await scanLocalEndpoints({
      hosts: ['127.0.0.1', 'localhost', '0.0.0.0'],
      skipDefaults: true,
      extraPorts: [9000, 9001],
      timeoutMs: 20,
    });
    // 3 hosts × 2 ports = 6 candidate /v1/models calls. No 11434 → no /api/tags fallback.
    const v1Calls = calls.filter((u) => u.endsWith('/v1/models'));
    expect(v1Calls.length).toBe(6);
  });
});

// ─── Concurrency cap ──────────────────────────────────────────────────────────

describe('scanLocalEndpoints — concurrency control', () => {
  it('never exceeds the configured concurrency cap', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const deferred: Array<() => void> = [];

    stubFetch(async () => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      // Each call hangs until we manually release it. We release them as a
      // batch from the test body after observing peak in-flight count.
      await new Promise<void>((resolve) => {
        deferred.push(() => {
          inFlight--;
          resolve();
        });
      });
      throw new TypeError('done');
    });

    const concurrency = 2;
    const portCount = 10;
    const promise = scanLocalEndpoints({
      hosts: ['127.0.0.1'],
      skipDefaults: true,
      extraPorts: Array.from({ length: portCount }, (_, i) => 9000 + i),
      concurrency,
      timeoutMs: 5000,
    });

    // Yield to the microtask queue so workers spin up and call fetch.
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    // At this instant, exactly `concurrency` calls should be parked in fetch.
    expect(inFlight).toBe(concurrency);
    expect(maxInFlight).toBe(concurrency);

    // Drain everything — release pending and any future ones as they arrive.
    while (deferred.length > 0) {
      const release = deferred.shift();
      if (release !== undefined) release();
      // Allow next batch of workers to enter fetch.
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
    }

    await promise;
    expect(maxInFlight).toBe(concurrency);
  });

  it('runs all candidates when concurrency exceeds candidate count', async () => {
    const calls: string[] = [];
    stubFetch(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      throw new TypeError('refused');
    });
    await scanLocalEndpoints({
      hosts: ['127.0.0.1'],
      skipDefaults: true,
      extraPorts: [9000, 9001, 9002],
      concurrency: 100,
      timeoutMs: 20,
    });
    expect(calls.length).toBe(3);
  });
});

// ─── Timeout ──────────────────────────────────────────────────────────────────

describe('scanLocalEndpoints — timeout', () => {
  it('drops candidates that hang past timeoutMs', async () => {
    stubFetch((_, init) => {
      const sig = init?.signal as AbortSignal | undefined;
      return new Promise<MockResponse>((_, reject) => {
        const fail = () => reject(new DOMException('timed out', 'TimeoutError'));
        if (sig?.aborted) {
          fail();
          return;
        }
        sig?.addEventListener('abort', fail);
      });
    });

    const started = Date.now();
    const results = await scanLocalEndpoints({
      hosts: ['127.0.0.1'],
      skipDefaults: true,
      extraPorts: [9000],
      timeoutMs: 50,
    });
    const elapsed = Date.now() - started;

    expect(results).toEqual([]);
    // Must have aborted close to timeoutMs, not waited the default 1500.
    expect(elapsed).toBeLessThan(500);
  });
});

// ─── AbortSignal ──────────────────────────────────────────────────────────────

describe('scanLocalEndpoints — AbortSignal', () => {
  it('returns [] when the outer signal is already aborted before scan starts', async () => {
    stubFetch(
      () =>
        new Promise<MockResponse>(() => {
          // never resolves
        }),
    );
    const ctrl = new AbortController();
    ctrl.abort();
    const results = await scanLocalEndpoints({
      hosts: ['127.0.0.1'],
      timeoutMs: 5000,
      signal: ctrl.signal,
    });
    expect(results).toEqual([]);
  });

  it('mid-flight abort halts further probing', async () => {
    let calls = 0;
    // Each fetch blocks until its own signal aborts. Without an outer abort,
    // every probe times out at timeoutMs. With one, the worker bails between
    // probes and we observe a much smaller call count.
    stubFetch((_, init) => {
      calls++;
      const sig = init?.signal as AbortSignal | undefined;
      return new Promise<MockResponse>((_, reject) => {
        const fail = () => reject(new DOMException('aborted', 'AbortError'));
        if (sig?.aborted) {
          fail();
          return;
        }
        sig?.addEventListener('abort', fail);
      });
    });

    const ctrl = new AbortController();
    const promise = scanLocalEndpoints({
      hosts: ['127.0.0.1'],
      skipDefaults: true,
      extraPorts: Array.from({ length: 100 }, (_, i) => 9000 + i),
      concurrency: 1,
      timeoutMs: 5000,
      signal: ctrl.signal,
    });
    // Let one probe start, then abort. The single worker should bail out of
    // its loop on the next iteration without dispatching the other 99.
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    ctrl.abort();
    await promise;
    // Exactly one probe ever entered fetch (concurrency=1, abort before next).
    expect(calls).toBeLessThan(5);
  });
});

// ─── Streaming ────────────────────────────────────────────────────────────────

describe('scanLocalEndpointsStreaming', () => {
  it('yields each endpoint as soon as its probe lands', async () => {
    // Two endpoints respond at staggered times. We assert the consumer sees
    // the first result before the second probe completes.
    const release1: { fn: (() => void) | null } = { fn: null };
    const release2: { fn: (() => void) | null } = { fn: null };

    stubFetch(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'http://127.0.0.1:9001/v1/models') {
        await new Promise<void>((r) => {
          release1.fn = r;
        });
        return jsonResponse({ data: [{ id: 'fast' }] });
      }
      if (url === 'http://127.0.0.1:9002/v1/models') {
        await new Promise<void>((r) => {
          release2.fn = r;
        });
        return jsonResponse({ data: [{ id: 'slow' }] });
      }
      throw new TypeError('refused');
    });

    const seen: DiscoveredEndpoint[] = [];
    const gen = scanLocalEndpointsStreaming({
      hosts: ['127.0.0.1'],
      skipDefaults: true,
      extraPorts: [9001, 9002],
      concurrency: 2,
      timeoutMs: 5000,
    });

    const consumer = (async () => {
      for await (const ep of gen) {
        seen.push(ep);
      }
    })();

    // Let both probes park in fetch.
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    // Release the first probe — consumer should observe it now, before the second resolves.
    expect(release1.fn).not.toBeNull();
    release1.fn?.();
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    expect(seen.map((e) => e.port)).toEqual([9001]);

    // Release the second.
    release2.fn?.();
    await consumer;
    expect(seen.map((e) => e.port).sort()).toEqual([9001, 9002]);
  });
});

// ─── Default ports sanity ─────────────────────────────────────────────────────

describe('DEFAULT_PORTS', () => {
  it('includes all required ports per spec', () => {
    const required = [11434, 1234, 8000, 8001, 8002, 8003, 8004, 8005, 8080, 5000];
    for (const p of required) {
      expect(DEFAULT_PORTS).toContain(p);
    }
  });
});
