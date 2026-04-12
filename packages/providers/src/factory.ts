import { OllamaProvider } from './ollama.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { AnthropicProvider } from './anthropic.js';
import type { ModelProvider, ProviderConfig, ProviderKind } from './types.js';

/**
 * Construct a `ModelProvider` for the given config. All OpenAI-compatible
 * server flavours share one class; only Ollama and Anthropic have dedicated
 * adapters because their discovery endpoints differ.
 */
export function makeProvider(config: ProviderConfig): ModelProvider {
  switch (config.kind) {
    case 'ollama':
      return new OllamaProvider(config);
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai':
    case 'openai-compatible':
    case 'lmstudio':
    case 'vllm':
    case 'localai':
    case 'llama-cpp':
    case 'custom':
      return new OpenAICompatibleProvider(config.kind, config);
  }
}

/** All provider kinds Pylon knows how to talk to, in menu order. */
export const PROVIDER_KIND_OPTIONS: Array<{
  kind: ProviderKind;
  label: string;
  defaultBaseUrl: string;
  defaultAuth: 'none' | 'api-key' | 'bearer';
  hint: string;
}> = [
  { kind: 'ollama',            label: 'Ollama',              defaultBaseUrl: 'http://localhost:11434',         defaultAuth: 'none',    hint: 'Local or remote Ollama server' },
  { kind: 'openai-compatible', label: 'OpenAI-compatible',   defaultBaseUrl: 'https://example.com/v1',         defaultAuth: 'bearer',  hint: 'Any server speaking /v1/models' },
  { kind: 'lmstudio',          label: 'LM Studio',           defaultBaseUrl: 'http://localhost:1234/v1',       defaultAuth: 'none',    hint: 'LM Studio desktop / headless' },
  { kind: 'vllm',              label: 'vLLM',                defaultBaseUrl: 'http://localhost:8000/v1',       defaultAuth: 'bearer',  hint: 'vLLM inference server' },
  { kind: 'localai',           label: 'LocalAI',             defaultBaseUrl: 'http://localhost:8080/v1',       defaultAuth: 'none',    hint: 'LocalAI container' },
  { kind: 'llama-cpp',         label: 'llama.cpp server',    defaultBaseUrl: 'http://localhost:8080/v1',       defaultAuth: 'none',    hint: 'llama-server OpenAI compat' },
  { kind: 'openai',            label: 'OpenAI',              defaultBaseUrl: 'https://api.openai.com/v1',      defaultAuth: 'bearer',  hint: 'api.openai.com' },
  { kind: 'anthropic',         label: 'Anthropic',           defaultBaseUrl: 'https://api.anthropic.com',      defaultAuth: 'api-key', hint: 'api.anthropic.com' },
  { kind: 'custom',            label: 'Custom',              defaultBaseUrl: '',                                defaultAuth: 'bearer',  hint: 'Anything else — hand-configured' },
];
