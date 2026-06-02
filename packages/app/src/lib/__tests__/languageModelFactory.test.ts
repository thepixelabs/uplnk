/**
 * Tests for packages/app/src/lib/languageModelFactory.ts
 *
 * Strategy: mock at the SDK boundary — we own the factory, not the AI SDK
 * providers. Assert call arguments and return value shape. No real HTTP.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mock state — vi.mock factories are hoisted to the top of the ─────
// module before any imports, so all captured variables must come from
// vi.hoisted() which runs in the same hoisted position.

const mocks = vi.hoisted(() => {
  const mockOpenAICompatibleModel = {
    specificationVersion: 'v1' as const,
    provider: 'openai-compat',
    modelId: 'llama3',
    defaultObjectGenerationMode: undefined as undefined,
    doGenerate: vi.fn(),
    doStream: vi.fn(),
  };

  const mockOpenAICompatibleProvider = vi.fn().mockReturnValue(mockOpenAICompatibleModel);
  const mockCreateOpenAICompatible = vi.fn().mockReturnValue(mockOpenAICompatibleProvider);

  return {
    mockOpenAICompatibleModel,
    mockOpenAICompatibleProvider,
    mockCreateOpenAICompatible,
  };
});

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mocks.mockCreateOpenAICompatible,
}));

// ─── Subject under test ────────────────────────────────────────────────────────

import { createLanguageModel } from '../languageModelFactory.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function getFirstCallArg(mockFn: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = mockFn.mock.calls[0];
  return call !== undefined ? (call[0] as Record<string, unknown>) : {};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createLanguageModel — openai-compatible branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockCreateOpenAICompatible.mockReturnValue(mocks.mockOpenAICompatibleProvider);
    mocks.mockOpenAICompatibleProvider.mockReturnValue(mocks.mockOpenAICompatibleModel);
  });

  it('calls createOpenAICompatible for ollama provider type', () => {
    createLanguageModel({
      providerType: 'ollama',
      baseURL: 'http://localhost:11434',
      apiKey: 'ollama',
      modelId: 'llama3',
    });

    expect(mocks.mockCreateOpenAICompatible).toHaveBeenCalledOnce();
  });

  it('appends /v1 to a baseURL that does not already end with /v1 (ollama style)', () => {
    createLanguageModel({
      providerType: 'ollama',
      baseURL: 'http://localhost:11434',
      apiKey: 'ollama',
      modelId: 'llama3',
    });

    const args = getFirstCallArg(mocks.mockCreateOpenAICompatible);
    expect(args['baseURL']).toBe('http://localhost:11434/v1');
  });

  it('does not double-append /v1 when baseURL already ends with /v1 (lmstudio style)', () => {
    createLanguageModel({
      providerType: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      apiKey: 'lmstudio',
      modelId: 'mistral',
    });

    const args = getFirstCallArg(mocks.mockCreateOpenAICompatible);
    expect(args['baseURL']).toBe('http://localhost:1234/v1');
  });

  it('strips trailing slash before /v1 check to avoid double-appending', () => {
    createLanguageModel({
      providerType: 'lmstudio',
      baseURL: 'http://localhost:1234/v1/',
      apiKey: '',
      modelId: 'phi3',
    });

    const args = getFirstCallArg(mocks.mockCreateOpenAICompatible);
    expect(args['baseURL']).toBe('http://localhost:1234/v1');
  });

  it('uses "openai-compat" as the provider name when providerType is empty', () => {
    createLanguageModel({
      providerType: '',
      baseURL: 'http://localhost:8080',
      apiKey: '',
      modelId: 'custom-model',
    });

    const args = getFirstCallArg(mocks.mockCreateOpenAICompatible);
    expect(args['name']).toBe('openai-compat');
  });

  it('uses the providerType as the provider name when it is non-empty', () => {
    createLanguageModel({
      providerType: 'vllm',
      baseURL: 'http://localhost:8000',
      apiKey: 'vllm-key',
      modelId: 'llama2',
    });

    const args = getFirstCallArg(mocks.mockCreateOpenAICompatible);
    expect(args['name']).toBe('vllm');
  });

  it('forwards the modelId and includeUsage flag to the provider function', () => {
    createLanguageModel({
      providerType: 'ollama',
      baseURL: 'http://localhost:11434',
      apiKey: 'ollama',
      modelId: 'qwen2.5:7b',
    });

    expect(mocks.mockOpenAICompatibleProvider).toHaveBeenCalledWith(
      'qwen2.5:7b',
      undefined,
      { includeUsage: true },
    );
  });

  it('returns an object with specificationVersion "v1"', () => {
    const model = createLanguageModel({
      providerType: 'ollama',
      baseURL: 'http://localhost:11434',
      apiKey: 'ollama',
      modelId: 'llama3',
    });

    expect(model.specificationVersion).toBe('v1');
  });
});
