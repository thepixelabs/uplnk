/**
 * Provider type identifiers. Matches the check constraint in
 * `provider_configs.provider_type`.
 */
export type ProviderKind =
  | 'ollama'
  | 'openai-compatible'
  | 'lmstudio'
  | 'vllm'
  | 'localai'
  | 'llama-cpp'
  | 'anthropic'
  | 'openai'
  | 'custom';

export type AuthMode = 'none' | 'api-key' | 'bearer';

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  authMode: AuthMode;
  apiKey?: string | undefined;
  /** Optional custom request timeout for model discovery (ms). */
  discoveryTimeoutMs?: number | undefined;
}

/**
 * A single model — either discovered from a live provider, pulled from the
 * static catalog, or merged from both sources.
 */
export interface Model {
  id: string;
  displayName: string;
  kind: ProviderKind;
  /** Where this row came from. A merge result reports `'both'`. */
  source: 'server' | 'catalog' | 'both';
  family?: string;
  /** Max input context length, in tokens. */
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Reported by Ollama and llama.cpp as bytes on disk. */
  sizeBytes?: number;
  /** USD per 1M input tokens. */
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  capabilities?: {
    tools?: boolean;
    vision?: boolean;
    streaming?: boolean;
  };
  /** Untyped provider-native payload; kept for detail panel + debugging. */
  raw?: unknown;
}

export interface HealthStatus {
  ok: boolean;
  latencyMs: number;
  /** Free-form string — e.g. "Ollama 0.3.14" or "13 models". */
  detail?: string;
  checkedAt: number;
}

export interface ModelProvider {
  readonly kind: ProviderKind;
  readonly config: ProviderConfig;
  testConnection(signal?: AbortSignal): Promise<HealthStatus>;
  listModels(signal?: AbortSignal): Promise<Model[]>;
}
