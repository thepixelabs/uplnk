import { describe, it, expect } from 'vitest';
import { resolveCapabilities, type CatalogEntry } from '@uplnk/catalog';

describe('resolveCapabilities', () => {
  it('resolves known tool-capable models via canonical key', () => {
    const caps = resolveCapabilities('anthropic', 'claude-sonnet-4-6');
    expect(caps.tools).toBe(true);
    expect(caps.vision).toBe(true);
    expect(caps.streaming).toBe(true);
    expect(caps.promptCaching).toBe(true);
  });

  it('resolves OpenAI gpt-4o as tool-capable', () => {
    expect(resolveCapabilities('openai', 'gpt-4o').tools).toBe(true);
  });

  it('resolves Ollama allowlist entries as tool-capable', () => {
    expect(resolveCapabilities('ollama', 'llama3.2').tools).toBe(true);
    expect(resolveCapabilities('ollama', 'qwen2.5-coder').tools).toBe(true);
  });

  it('returns tools=false for Ollama models not on the allowlist', () => {
    // gemma2 in the built-in catalog lacks a `capabilities.tools: true` flag
    expect(resolveCapabilities('ollama', 'gemma2').tools).toBe(false);
  });

  it('returns conservative defaults for unknown models', () => {
    const caps = resolveCapabilities('ollama', 'something-nobody-has-heard-of');
    expect(caps).toEqual({
      tools: false,
      vision: false,
      streaming: true,
      promptCaching: false,
    });
  });

  it('accepts a catalog override so callers can inject their own entries', () => {
    const custom: CatalogEntry[] = [
      {
        canonicalKey: 'custom/my-model',
        displayId: 'my-model',
        kind: 'custom',
        capabilities: { tools: true, vision: false },
      },
    ];
    const caps = resolveCapabilities('custom', 'my-model', custom);
    expect(caps.tools).toBe(true);
    expect(caps.vision).toBe(false);
  });

  it('falls back to displayId match when canonical-key lookup misses', () => {
    // llama3.2 canonicalKey is 'ollama/llama3.2' — if the caller hands us a
    // mismatched kind we still find it by displayId.
    const caps = resolveCapabilities('custom', 'llama3.2');
    expect(caps.tools).toBe(true);
  });
});
