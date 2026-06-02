/**
 * Language model factory — picks the right AI SDK provider based on the
 * stored `providerType` on a `provider_configs` row.
 *
 * Every supported provider speaks the OpenAI `/v1/chat/completions` shape,
 * so we route through `@ai-sdk/openai-compatible`'s `createOpenAICompatible`
 * regardless of kind. This covers Ollama, LM Studio, vLLM, LocalAI,
 * llama.cpp, raw OpenAI, and custom endpoints.
 *
 * Returns a `LanguageModelV1` so the streaming hook and the model router
 * do not need to care which backend is in use.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
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
 * The base URL is normalised to the `/v1` root expected by the SDK —
 * callers may have stored either `http://host:11434` (Ollama native) or
 * `http://host:11434/v1` (OpenAI-compat mount).
 */
export function createLanguageModel(
  input: LanguageModelFactoryInput,
): LanguageModelV1 {
  const baseURL = /\/v1\/?$/.test(input.baseURL)
    ? input.baseURL.replace(/\/+$/, '')
    : `${input.baseURL.replace(/\/+$/, '')}/v1`;
  const provider = createOpenAICompatible({
    name: input.providerType || 'openai-compat',
    baseURL,
    apiKey: input.apiKey,
  });
  // Force stream_options: { include_usage: true } on every chat completion.
  // OpenAI's streaming spec omits usage by default; Ollama / LM Studio /
  // vLLM all honor this flag and emit a final chunk with prompt + completion
  // token counts, which the AI SDK surfaces as `finish.usage`. Without it
  // the header live counter and end-of-turn stats stay empty.
  return provider(input.modelId, undefined, { includeUsage: true });
}
