/**
 * Live context-length probing — Phase A.1.6.
 *
 * Covers the wire→Model.contextWindow paths added in:
 *   - OpenAICompatibleProvider.listModels (vLLM `max_model_len`,
 *     llama.cpp `/slots` n_ctx, LM Studio "no signal")
 *   - OllamaProvider.getModelDetail (/api/show `parameters` + `model_info`)
 *
 * fetch is mocked at the global boundary; no real network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  OpenAICompatibleProvider,
  OllamaProvider,
  mergeWithCatalog,
} from '@uplnk/providers';
import type { ProviderConfig } from '@uplnk/providers';
import type { CatalogEntry } from '@uplnk/catalog';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function vllmConfig(baseUrl = 'http://localhost:8000/v1'): ProviderConfig {
  return {
    id: 'vllm-1',
    name: 'vllm-local',
    kind: 'vllm',
    baseUrl,
    authMode: 'none',
  };
}

function lmStudioConfig(baseUrl = 'http://localhost:1234/v1'): ProviderConfig {
  return {
    id: 'lms-1',
    name: 'lmstudio',
    kind: 'lmstudio',
    baseUrl,
    authMode: 'none',
  };
}

function llamaCppConfig(baseUrl = 'http://localhost:8080/v1'): ProviderConfig {
  return {
    id: 'llcp-1',
    name: 'llama-cpp',
    kind: 'llama-cpp',
    baseUrl,
    authMode: 'none',
  };
}

function ollamaConfig(baseUrl = 'http://localhost:11434'): ProviderConfig {
  return {
    id: 'oll-1',
    name: 'ollama',
    kind: 'ollama',
    baseUrl,
    authMode: 'none',
  };
}

/** Build a Response-like object from a JSON body. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Setup ───────────────────────────────────────────────────────────────────

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── OpenAI-compatible: vLLM with max_model_len ──────────────────────────────

describe('OpenAICompatibleProvider live context-length probing', () => {
  it('flows vLLM max_model_len through to Model.contextWindow', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'meta-llama/Llama-3.1-8B-Instruct',
            object: 'model',
            max_model_len: 32768,
          },
        ],
      }),
    );

    const provider = new OpenAICompatibleProvider('vllm', vllmConfig());
    const models = await provider.listModels();

    expect(models).toHaveLength(1);
    expect(models[0]!.contextWindow).toBe(32768);
    expect(models[0]!.source).toBe('server');
  });

  it('flows context_length through when max_model_len is absent', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: 'mistral-7b', context_length: 8192 }],
      }),
    );

    const provider = new OpenAICompatibleProvider('openai-compatible', {
      ...vllmConfig(),
      kind: 'openai-compatible',
    });
    const models = await provider.listModels();

    expect(models[0]!.contextWindow).toBe(8192);
  });

  it('prefers max_model_len when both fields are present (vLLM precedence)', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: 'm', max_model_len: 16384, context_length: 8192 }],
      }),
    );

    const provider = new OpenAICompatibleProvider('vllm', vllmConfig());
    const models = await provider.listModels();
    expect(models[0]!.contextWindow).toBe(16384);
  });

  it('leaves contextWindow undefined when no context field is on the wire (LM Studio)', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: 'qwen2.5-7b-instruct', object: 'model' }],
      }),
    );

    const provider = new OpenAICompatibleProvider('lmstudio', lmStudioConfig());
    const models = await provider.listModels();

    expect(models).toHaveLength(1);
    expect(models[0]!.contextWindow).toBeUndefined();
  });

  it('ignores zero/negative context values from misbehaving servers', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { id: 'a', max_model_len: 0 },
          { id: 'b', context_length: -1 },
        ],
      }),
    );

    const provider = new OpenAICompatibleProvider('vllm', vllmConfig());
    const models = await provider.listModels();
    expect(models[0]!.contextWindow).toBeUndefined();
    expect(models[1]!.contextWindow).toBeUndefined();
  });
});

// ─── llama.cpp /slots probe ──────────────────────────────────────────────────

describe('OpenAICompatibleProvider llama.cpp /slots probe', () => {
  it('reads n_ctx from /slots and overrides any catalog value', async () => {
    // First call: /v1/models (no context fields)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ data: [{ id: 'gguf-model.q4', object: 'model' }] }),
    );
    // Second call: /slots
    fetchSpy.mockResolvedValueOnce(jsonResponse([{ n_ctx: 8192 }]));

    const provider = new OpenAICompatibleProvider('llama-cpp', llamaCppConfig());
    const models = await provider.listModels();

    expect(models).toHaveLength(1);
    expect(models[0]!.contextWindow).toBe(8192);

    // Through merge: catalog says 4096, but live wins.
    const catalog: CatalogEntry[] = [
      {
        canonicalKey: 'gguf-model.q4',
        displayId: 'gguf-model.q4',
        kind: 'llama-cpp',
        contextWindow: 4096,
      },
    ];
    const merged = mergeWithCatalog('llama-cpp', models, catalog);
    expect(merged.installed[0]!.contextWindow).toBe(8192);

    // Sanity: /slots URL is at the root, not under /v1.
    const slotsCall = fetchSpy.mock.calls[1]!;
    expect(String(slotsCall[0])).toMatch(/\/slots$/);
    expect(String(slotsCall[0])).not.toMatch(/\/v1\/slots$/);
  });

  it('treats /slots 404 as graceful no-signal — catalog wins downstream', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ data: [{ id: 'gguf-model.q4', object: 'model' }] }),
    );
    fetchSpy.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    const provider = new OpenAICompatibleProvider('llama-cpp', llamaCppConfig());
    const models = await provider.listModels();

    expect(models).toHaveLength(1);
    expect(models[0]!.contextWindow).toBeUndefined();

    const catalog: CatalogEntry[] = [
      {
        canonicalKey: 'gguf-model.q4',
        displayId: 'gguf-model.q4',
        kind: 'llama-cpp',
        contextWindow: 4096,
      },
    ];
    const merged = mergeWithCatalog('llama-cpp', models, catalog);
    expect(merged.installed[0]!.contextWindow).toBe(4096);
  });

  it('treats /slots connection failure as graceful no-signal', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ data: [{ id: 'm', object: 'model' }] }),
    );
    // 2 attempts (fetchJson retries once) — return network failure both times.
    fetchSpy.mockRejectedValueOnce(new TypeError('ECONNREFUSED'));
    fetchSpy.mockRejectedValueOnce(new TypeError('ECONNREFUSED'));

    const provider = new OpenAICompatibleProvider('llama-cpp', llamaCppConfig());
    const models = await provider.listModels();
    expect(models[0]!.contextWindow).toBeUndefined();
  });

  it('does NOT call /slots for non-llama-cpp kinds', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ data: [{ id: 'm', max_model_len: 4096 }] }),
    );

    const provider = new OpenAICompatibleProvider('vllm', vllmConfig());
    await provider.listModels();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toMatch(/\/v1\/models$/);
  });

  it('prefers /slots n_ctx over wire context_length on the model row', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [{ id: 'm', context_length: 4096 }],
      }),
    );
    fetchSpy.mockResolvedValueOnce(jsonResponse([{ n_ctx: 16384 }]));

    const provider = new OpenAICompatibleProvider('llama-cpp', llamaCppConfig());
    const models = await provider.listModels();
    expect(models[0]!.contextWindow).toBe(16384);
  });
});

// ─── Ollama getModelDetail ───────────────────────────────────────────────────

describe('OllamaProvider.getModelDetail', () => {
  it('parses num_ctx from /api/show parameters string', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        parameters: 'num_ctx 8192\nstop "<|im_end|>"\ntemperature 0.7',
        details: { family: 'llama' },
        model_info: {},
      }),
    );

    const provider = new OllamaProvider(ollamaConfig());
    const detail = await provider.getModelDetail('llama3.2:3b');

    expect(detail.id).toBe('llama3.2:3b');
    expect(detail.contextWindow).toBe(8192);
    expect(detail.family).toBe('llama');

    // Confirm it was a POST to /api/show with the right body.
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/show$/);
    const reqInit = init as RequestInit;
    expect(reqInit.method).toBe('POST');
    expect(JSON.parse(String(reqInit.body))).toEqual({ name: 'llama3.2:3b' });
  });

  it('falls back to model_info <arch>.context_length when parameters lack num_ctx', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        parameters: 'stop "<|end|>"',
        model_info: {
          'general.architecture': 'qwen2',
          'qwen2.context_length': 32768,
          'qwen2.attention.head_count': 14,
        },
        details: { family: 'qwen2' },
      }),
    );

    const provider = new OllamaProvider(ollamaConfig());
    const detail = await provider.getModelDetail('qwen2.5:7b');
    expect(detail.contextWindow).toBe(32768);
    expect(detail.family).toBe('qwen2');
  });

  it('prefers parameters num_ctx over model_info context_length (user override wins)', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        parameters: 'num_ctx 4096',
        model_info: { 'llama.context_length': 131072 },
      }),
    );

    const provider = new OllamaProvider(ollamaConfig());
    const detail = await provider.getModelDetail('llama3.1:8b');
    expect(detail.contextWindow).toBe(4096);
  });

  it('returns undefined contextWindow when neither source carries it', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        parameters: 'stop "<|end|>"',
        model_info: { 'general.architecture': 'mystery' },
      }),
    );

    const provider = new OllamaProvider(ollamaConfig());
    const detail = await provider.getModelDetail('unknown-model');
    expect(detail.contextWindow).toBeUndefined();
  });

  it('treats /api/show 404 as graceful no-signal', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    const provider = new OllamaProvider(ollamaConfig());
    const detail = await provider.getModelDetail('missing-model');
    expect(detail).toEqual({ id: 'missing-model' });
  });

  it('listModels still leaves contextWindow undefined (lazy strategy)', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        models: [
          {
            name: 'llama3.2:3b',
            size: 2_000_000_000,
            details: { family: 'llama' },
          },
        ],
      }),
    );

    const provider = new OllamaProvider(ollamaConfig());
    const models = await provider.listModels();
    expect(models[0]!.contextWindow).toBeUndefined();
    expect(models[0]!.family).toBe('llama');
    expect(models[0]!.sizeBytes).toBe(2_000_000_000);
  });
});

// ─── Merge precedence rule ───────────────────────────────────────────────────

describe('mergeWithCatalog — live wire wins over catalog for contextWindow', () => {
  it('keeps live contextWindow when catalog has a different value', () => {
    const live = [
      {
        id: 'mistral-7b',
        displayName: 'mistral-7b',
        kind: 'vllm' as const,
        source: 'server' as const,
        contextWindow: 32768,
      },
    ];
    const catalog: CatalogEntry[] = [
      {
        canonicalKey: 'mistral-7b',
        displayId: 'mistral-7b',
        kind: 'vllm',
        contextWindow: 8192,
        capabilities: { tools: true },
      },
    ];
    const merged = mergeWithCatalog('vllm', live, catalog);
    expect(merged.installed[0]!.contextWindow).toBe(32768);
    // Catalog still contributes capabilities (not on the wire).
    expect(merged.installed[0]!.capabilities?.tools).toBe(true);
    expect(merged.installed[0]!.source).toBe('both');
  });

  it('falls back to catalog contextWindow when live is undefined', () => {
    const live = [
      {
        id: 'lmstudio-model',
        displayName: 'lmstudio-model',
        kind: 'lmstudio' as const,
        source: 'server' as const,
      },
    ];
    const catalog: CatalogEntry[] = [
      {
        canonicalKey: 'lmstudio-model',
        displayId: 'lmstudio-model',
        kind: 'lmstudio',
        contextWindow: 16384,
      },
    ];
    const merged = mergeWithCatalog('lmstudio', live, catalog);
    expect(merged.installed[0]!.contextWindow).toBe(16384);
  });
});
