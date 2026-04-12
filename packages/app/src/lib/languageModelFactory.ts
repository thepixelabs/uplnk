/**
 * Language model factory — picks the right AI SDK provider based on the
 * stored `providerType` on a `provider_configs` row.
 *
 * Today only two branches exist in practice:
 *
 *   - `anthropic`     → `@ai-sdk/anthropic`'s `createAnthropic` (uses the
 *                       native Messages API with `x-api-key` auth)
 *   - everything else → `@ai-sdk/openai-compatible`'s `createOpenAICompatible`
 *                       (covers Ollama, LM Studio, vLLM, LocalAI, llama.cpp,
 *                       raw OpenAI, and custom endpoints since they all speak
 *                       the `/v1/chat/completions` shape)
 *
 * Both branches return a `LanguageModelV1` so the streaming hook and the
 * model router do not need to care which backend is in use.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModelV1 } from '@ai-sdk/provider';

export interface LanguageModelFactoryInput {
  providerType: string;
  baseURL: string;
  apiKey: string;
  modelId: string;
}

/**
 * Build a `LanguageModelV1` for the given provider + model pair.
 *
 * The OpenAI-compatible branch normalises the base URL to the `/v1` root
 * expected by the SDK — callers may have stored either `http://host:11434`
 * (Ollama native) or `http://host:11434/v1` (OpenAI-compat mount).
 *
 * The Anthropic branch strips any trailing `/v1` the user might have stored
 * (the SDK appends its own path). It uses `x-api-key` auth internally.
 */
export function createLanguageModel(
  input: LanguageModelFactoryInput,
): LanguageModelV1 {
  if (input.providerType === 'anthropic') {
    const base = input.baseURL.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
    const provider = createAnthropic({
      apiKey: input.apiKey,
      baseURL: `${base}/v1`,
    });
    return provider(input.modelId);
  }

  // OpenAI-compatible handles every other provider kind today.
  const baseURL = /\/v1\/?$/.test(input.baseURL)
    ? input.baseURL.replace(/\/+$/, '')
    : `${input.baseURL.replace(/\/+$/, '')}/v1`;
  const provider = createOpenAICompatible({
    name: input.providerType || 'openai-compat',
    baseURL,
    apiKey: input.apiKey,
  });
  return provider(input.modelId);
}
