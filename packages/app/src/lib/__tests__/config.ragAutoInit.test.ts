/**
 * Tests for probeOllamaEmbedder() and maybeAutoEnableRag() in
 * packages/app/src/lib/config.ts.
 *
 * Strategy: stub fetch globally via vi.stubGlobal. No real HTTP. No file I/O.
 * The two functions are pure with respect to the module — they only call fetch
 * and mutate the config object passed in.
 *
 * uplnk-db is mocked (global setup.ts does this) so importing config.ts does
 * not open a SQLite file. We import only the two exported functions under test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── uplnk-db mock (supplements global setup.ts stub) ────────────────────────

vi.mock('uplnk-db', () => ({
  db: {},
  getPylonDir: vi.fn(() => '/tmp/pylon-test-home/.pylon'),
  getPylonDbPath: vi.fn(() => '/tmp/pylon-test-home/.uplnk/db.sqlite'),
  upsertProviderConfig: vi.fn(),
  getDefaultProvider: vi.fn(() => undefined),
  listProviders: vi.fn(() => []),
  getProviderById: vi.fn(() => undefined),
  setDefaultProvider: vi.fn(),
}));

// secrets.ts is imported transitively; mock it to avoid crypto/fs side effects
vi.mock('../secrets.js', () => ({
  migratePlaintext: vi.fn((v: string) => `@secret:${v}`),
  isSecretRef: vi.fn((v: string) => v.startsWith('@secret:')),
  initSecretsBackend: vi.fn(async () => ({ name: 'encrypted-file' })),
  getSecretsBackend: vi.fn(() => ({ name: 'encrypted-file' })),
}));

import { probeOllamaEmbedder, maybeAutoEnableRag } from '../config.js';
import type { Config } from '../config.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFetchResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

function makeConfig(overrides: Partial<Config['rag']> = {}): Config {
  return {
    version: 1,
    theme: 'dark',
    telemetry: { enabled: false },
    mcp: {
      allowedPaths: [],
      commandExecEnabled: false,
      commandAllowlistAdditions: [],
      servers: [],
    },
    git: { enabled: true },
    updates: { enabled: true, packageName: 'uplnk' },
    providers: [],
    rag: {
      enabled: false,
      autoDetect: true,
      ...overrides,
    },
  } satisfies Config;
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── probeOllamaEmbedder ──────────────────────────────────────────────────────

describe('probeOllamaEmbedder — success path', () => {
  it('should return the matched model name when /api/tags contains nomic-embed-text', async () => {
    fetchSpy.mockResolvedValue(
      makeFetchResponse({ models: [{ name: 'nomic-embed-text:latest' }] }),
    );

    const result = await probeOllamaEmbedder('http://localhost:11434');

    expect(result).toBe('nomic-embed-text:latest');
  });

  it('should return the matching model even when other models are present', async () => {
    fetchSpy.mockResolvedValue(
      makeFetchResponse({
        models: [
          { name: 'llama3:latest' },
          { name: 'nomic-embed-text:v1.5' },
          { name: 'qwen2.5:7b' },
        ],
      }),
    );

    const result = await probeOllamaEmbedder('http://localhost:11434');

    expect(result).toBe('nomic-embed-text:v1.5');
  });

  it('should call fetch with /api/tags appended to a localhost baseUrl', async () => {
    fetchSpy.mockResolvedValue(
      makeFetchResponse({ models: [{ name: 'nomic-embed-text:latest' }] }),
    );

    await probeOllamaEmbedder('http://127.0.0.1:11434');

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/tags',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('strips a trailing /v1 from the explicit baseUrl argument before appending /api/tags', async () => {
    // Security gate round 2 (QA finding): the /v1-strip used to live in the
    // default parameter expression only, so explicit callers got
    // `/v1/api/tags` (404). Fixed in the function body — now the strip
    // applies to both default and explicit baseUrl values.
    fetchSpy.mockResolvedValue(
      makeFetchResponse({ models: [{ name: 'nomic-embed-text:latest' }] }),
    );

    await probeOllamaEmbedder('http://localhost:11434/v1');

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:11434/api/tags',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('refuses to probe non-localhost URLs without UPLNK_TRUST_OLLAMA_URL=1 (SSRF guard)', async () => {
    // Security gate round 2 finding M2: OLLAMA_BASE_URL is user-controllable
    // and could be aimed at internal addresses (e.g. cloud metadata endpoints)
    // without an explicit trust opt-in.
    delete process.env['UPLNK_TRUST_OLLAMA_URL'];
    fetchSpy.mockResolvedValue(
      makeFetchResponse({ models: [{ name: 'nomic-embed-text:latest' }] }),
    );

    const result = await probeOllamaEmbedder('http://internal-service:11434');

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows non-localhost URLs when UPLNK_TRUST_OLLAMA_URL=1', async () => {
    process.env['UPLNK_TRUST_OLLAMA_URL'] = '1';
    try {
      fetchSpy.mockResolvedValue(
        makeFetchResponse({ models: [{ name: 'nomic-embed-text:latest' }] }),
      );

      const result = await probeOllamaEmbedder('http://lan-server:11434');

      expect(result).toBe('nomic-embed-text:latest');
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://lan-server:11434/api/tags',
        expect.any(Object),
      );
    } finally {
      delete process.env['UPLNK_TRUST_OLLAMA_URL'];
    }
  });
});

describe('probeOllamaEmbedder — failure paths', () => {
  it('should return null on network error (fetch throws)', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await probeOllamaEmbedder('http://localhost:11434');

    expect(result).toBeNull();
  });

  it('should return null when response is not ok (HTTP 500)', async () => {
    fetchSpy.mockResolvedValue(makeFetchResponse({}, false, 500));

    const result = await probeOllamaEmbedder('http://localhost:11434');

    expect(result).toBeNull();
  });

  it('should return null when response is not ok (HTTP 404)', async () => {
    fetchSpy.mockResolvedValue(makeFetchResponse({}, false, 404));

    const result = await probeOllamaEmbedder('http://localhost:11434');

    expect(result).toBeNull();
  });

  it('should return null when json() throws (parse failure)', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    } as unknown as Response);

    const result = await probeOllamaEmbedder('http://localhost:11434');

    expect(result).toBeNull();
  });

  it('should return null when models array is absent from the JSON body', async () => {
    fetchSpy.mockResolvedValue(makeFetchResponse({ something: 'else' }));

    const result = await probeOllamaEmbedder('http://localhost:11434');

    expect(result).toBeNull();
  });

  it('should return null when models array is present but empty', async () => {
    fetchSpy.mockResolvedValue(makeFetchResponse({ models: [] }));

    const result = await probeOllamaEmbedder('http://localhost:11434');

    expect(result).toBeNull();
  });

  it('should return null when no model name includes nomic-embed-text', async () => {
    fetchSpy.mockResolvedValue(
      makeFetchResponse({ models: [{ name: 'llama3:latest' }, { name: 'qwen2.5:7b' }] }),
    );

    const result = await probeOllamaEmbedder('http://localhost:11434');

    expect(result).toBeNull();
  });

  it('should return null when models array contains entries without a name field', async () => {
    fetchSpy.mockResolvedValue(
      makeFetchResponse({ models: [{ size: 1234 }, { digest: 'abc' }] }),
    );

    const result = await probeOllamaEmbedder('http://localhost:11434');

    expect(result).toBeNull();
  });
});

// ─── maybeAutoEnableRag ───────────────────────────────────────────────────────

describe('maybeAutoEnableRag — short-circuit paths (no mutation)', () => {
  it('should return false and not mutate when rag.enabled is already true', async () => {
    const config = makeConfig({ enabled: true });

    const result = await maybeAutoEnableRag(config);

    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(config.rag.enabled).toBe(true); // unchanged
  });

  it('should return false and not mutate when rag.autoDetect is false', async () => {
    const config = makeConfig({ autoDetect: false });

    const result = await maybeAutoEnableRag(config);

    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should return false and not mutate when rag.embed is already set', async () => {
    const config = makeConfig({
      embed: { baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama', model: 'nomic-embed-text:latest' },
    });

    const result = await maybeAutoEnableRag(config);

    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should return false when probe returns null (Ollama unreachable)', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    const config = makeConfig();

    const result = await maybeAutoEnableRag(config);

    expect(result).toBe(false);
    expect(config.rag.enabled).toBe(false);
    expect(config.rag.embed).toBeUndefined();
  });

  it('should return false when probe finds no embedding model', async () => {
    fetchSpy.mockResolvedValue(makeFetchResponse({ models: [{ name: 'llama3:latest' }] }));
    const config = makeConfig();

    const result = await maybeAutoEnableRag(config);

    expect(result).toBe(false);
    expect(config.rag.enabled).toBe(false);
  });
});

describe('maybeAutoEnableRag — auto-enable path', () => {
  it('should return true and set rag.enabled + rag.embed when probe finds an embedder', async () => {
    fetchSpy.mockResolvedValue(
      makeFetchResponse({ models: [{ name: 'nomic-embed-text:latest' }] }),
    );
    const config = makeConfig();

    const result = await maybeAutoEnableRag(config);

    expect(result).toBe(true);
    expect(config.rag.enabled).toBe(true);
    expect(config.rag.embed).toBeDefined();
    expect(config.rag.embed?.model).toBe('nomic-embed-text:latest');
  });

  it('should set rag.embed.apiKey to "ollama" after auto-enable', async () => {
    fetchSpy.mockResolvedValue(
      makeFetchResponse({ models: [{ name: 'nomic-embed-text:latest' }] }),
    );
    const config = makeConfig();

    await maybeAutoEnableRag(config);

    expect(config.rag.embed?.apiKey).toBe('ollama');
  });

  it('should set rag.embed.baseUrl to the Ollama base URL with /v1 appended', async () => {
    fetchSpy.mockResolvedValue(
      makeFetchResponse({ models: [{ name: 'nomic-embed-text:latest' }] }),
    );
    const config = makeConfig();

    await maybeAutoEnableRag(config);

    expect(config.rag.embed?.baseUrl).toMatch(/\/v1$/);
  });

  it('should mutate the same config object (in-place, not a copy)', async () => {
    fetchSpy.mockResolvedValue(
      makeFetchResponse({ models: [{ name: 'nomic-embed-text:latest' }] }),
    );
    const config = makeConfig();
    const ragRef = config.rag;

    await maybeAutoEnableRag(config);

    // rag object identity is the same reference — mutated in place
    expect(config.rag).toBe(ragRef);
    expect(config.rag.enabled).toBe(true);
  });
});
