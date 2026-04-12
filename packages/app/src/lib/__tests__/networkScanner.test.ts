import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseOllamaTags,
  parseOpenAIModels,
  getLocalSubnetHosts,
  scanNetwork,
} from '../networkScanner.js';

// ─── parseOllamaTags ──────────────────────────────────────────────────────────

describe('parseOllamaTags', () => {
  it('parses a valid Ollama /api/tags response', () => {
    const body = {
      models: [
        { name: 'llama3.2:3b', size: 123 },
        { name: 'qwen2.5:7b', size: 456 },
      ],
    };
    const result = parseOllamaTags(body);
    expect(result).not.toBeNull();
    expect(result?.models).toEqual(['llama3.2:3b', 'qwen2.5:7b']);
  });

  it('caps models at 5 entries', () => {
    const body = {
      models: [
        { name: 'a' },
        { name: 'b' },
        { name: 'c' },
        { name: 'd' },
        { name: 'e' },
        { name: 'f' },
      ],
    };
    const result = parseOllamaTags(body);
    expect(result?.models).toHaveLength(5);
  });

  it('filters out entries with no name', () => {
    const body = {
      models: [{ name: 'good' }, {}, { name: '' }],
    };
    const result = parseOllamaTags(body);
    expect(result?.models).toEqual(['good']);
  });

  it('returns null when models key is missing', () => {
    expect(parseOllamaTags({ other: [] })).toBeNull();
  });

  it('returns null when models is not an array', () => {
    expect(parseOllamaTags({ models: 'not-an-array' })).toBeNull();
  });

  it('returns null for null input', () => {
    expect(parseOllamaTags(null)).toBeNull();
  });

  it('returns null for a primitive input', () => {
    expect(parseOllamaTags('string')).toBeNull();
    expect(parseOllamaTags(42)).toBeNull();
  });
});

// ─── parseOpenAIModels ────────────────────────────────────────────────────────

describe('parseOpenAIModels', () => {
  it('parses a valid OpenAI-compatible /v1/models response', () => {
    const body = {
      data: [{ id: 'gpt-4o' }, { id: 'gpt-4-turbo' }],
      object: 'list',
    };
    const result = parseOpenAIModels(body);
    expect(result).not.toBeNull();
    expect(result?.models).toEqual(['gpt-4o', 'gpt-4-turbo']);
  });

  it('caps models at 5 entries', () => {
    const body = {
      data: [
        { id: 'a' },
        { id: 'b' },
        { id: 'c' },
        { id: 'd' },
        { id: 'e' },
        { id: 'f' },
      ],
    };
    const result = parseOpenAIModels(body);
    expect(result?.models).toHaveLength(5);
  });

  it('filters out entries with no id', () => {
    const body = {
      data: [{ id: 'valid' }, {}, { id: '' }],
    };
    const result = parseOpenAIModels(body);
    expect(result?.models).toEqual(['valid']);
  });

  it('returns null when data key is missing', () => {
    expect(parseOpenAIModels({ models: [] })).toBeNull();
  });

  it('returns null when data is not an array', () => {
    expect(parseOpenAIModels({ data: 'bad' })).toBeNull();
  });

  it('returns null for null input', () => {
    expect(parseOpenAIModels(null)).toBeNull();
  });

  it('returns null for an empty object', () => {
    expect(parseOpenAIModels({})).toBeNull();
  });
});

// ─── getLocalSubnetHosts ──────────────────────────────────────────────────────

describe('getLocalSubnetHosts', () => {
  it('returns localhost addresses for scope=localhost', () => {
    const hosts = getLocalSubnetHosts('localhost');
    expect(hosts).toContain('127.0.0.1');
    expect(hosts).toContain('localhost');
    // Must be exactly these two — no subnet expansion
    expect(hosts).toHaveLength(2);
  });

  it('always includes loopback entries for scope=subnet', () => {
    const hosts = getLocalSubnetHosts('subnet');
    expect(hosts).toContain('127.0.0.1');
    expect(hosts).toContain('localhost');
  });

  it('never exceeds 512 total hosts', () => {
    const hosts = getLocalSubnetHosts('subnet');
    expect(hosts.length).toBeLessThanOrEqual(512);
  });

  it('contains no duplicate entries', () => {
    const hosts = getLocalSubnetHosts('subnet');
    expect(new Set(hosts).size).toBe(hosts.length);
  });
});

// ─── scanNetwork — fetch mock ─────────────────────────────────────────────────

describe('scanNetwork', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the one server whose probe succeeds', async () => {
    const ollamaBody = {
      models: [{ name: 'qwen2.5:7b' }, { name: 'llama3.2:3b' }],
    };

    // Respond successfully only to the Ollama probe on localhost:11434
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request | string | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === 'http://127.0.0.1:11434/api/tags' || url === 'http://localhost:11434/api/tags') {
          return {
            ok: true,
            json: async () => ollamaBody,
          } as Response;
        }
        // Everything else fails — simulates no other servers running
        throw new TypeError('Network error');
      }),
    );

    const discovered: string[] = [];
    const result = await scanNetwork({
      scope: 'localhost',
      timeoutMs: 100,
      onResult: (s) => discovered.push(s.id),
    });

    // Exactly one server should be found (Ollama on 127.0.0.1)
    // Note: both 127.0.0.1 and localhost are probed; depending on which
    // resolves first we may get one or two hits. We assert at least one.
    expect(result.servers.length).toBeGreaterThanOrEqual(1);

    // The discovered server must be Ollama
    expect(result.servers.every((s) => s.kind === 'ollama')).toBe(true);
    expect(result.servers[0]!.models).toEqual(['qwen2.5:7b', 'llama3.2:3b']);

    // onResult was called once per found server
    expect(discovered.length).toBe(result.servers.length);
  });

  it('returns zero servers when all probes fail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Network error');
      }),
    );

    const result = await scanNetwork({ scope: 'localhost', timeoutMs: 50 });
    expect(result.servers).toHaveLength(0);
    expect(result.hostsProbed).toBe(2); // 127.0.0.1 + localhost
  });

  it('includes hostsProbed and durationMs in result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Network error');
      }),
    );

    const result = await scanNetwork({ scope: 'localhost', timeoutMs: 50 });
    expect(result.hostsProbed).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('respects AbortSignal — aborting before probes start yields no results', async () => {
    // Make fetch hang indefinitely so the only way to get 0 results is
    // via the abort-before-start gate in each task closure.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>(() => {
            // never resolves
          }),
      ),
    );

    const controller = new AbortController();
    // Abort synchronously before scanNetwork can dispatch any probes
    controller.abort();

    const result = await scanNetwork({
      scope: 'localhost',
      timeoutMs: 5000,
      signal: controller.signal,
    });

    expect(result.servers).toHaveLength(0);
  });

  it('calls onResult for each discovered server', async () => {
    const ollamaBody = { models: [{ name: 'phi3:mini' }] };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request | string | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes(':11434/api/tags')) {
          return { ok: true, json: async () => ollamaBody } as Response;
        }
        throw new TypeError('Network error');
      }),
    );

    const callbacks: string[] = [];
    await scanNetwork({
      scope: 'localhost',
      timeoutMs: 100,
      onResult: (s) => callbacks.push(s.id),
    });

    // At least one onResult call per Ollama host (127.0.0.1 and localhost)
    expect(callbacks.length).toBeGreaterThanOrEqual(1);
    expect(callbacks.every((id) => id.includes('ollama'))).toBe(true);
  });
});
