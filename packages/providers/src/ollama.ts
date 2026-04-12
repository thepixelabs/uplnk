import { fetchJson, joinUrl } from './base.js';
import type { ModelProvider, ProviderConfig, Model, HealthStatus } from './types.js';

interface OllamaTagsResponse {
  models: Array<{
    name: string;
    model?: string;
    size?: number;
    modified_at?: string;
    details?: {
      family?: string;
      parameter_size?: string;
      quantization_level?: string;
    };
  }>;
}

/**
 * Ollama exposes `/api/tags` on its *native* API root (not `/v1`).
 * If the user supplies an OpenAI-compatible base ending in `/v1`, strip it
 * so discovery hits the right endpoint.
 */
function nativeRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}

export class OllamaProvider implements ModelProvider {
  readonly kind = 'ollama' as const;
  constructor(readonly config: ProviderConfig) {}

  async testConnection(signal?: AbortSignal): Promise<HealthStatus> {
    const started = Date.now();
    const models = await this.listModels(signal);
    return {
      ok: true,
      latencyMs: Date.now() - started,
      detail: `${String(models.length)} models available`,
      checkedAt: Date.now(),
    };
  }

  async listModels(signal?: AbortSignal): Promise<Model[]> {
    const url = joinUrl(nativeRoot(this.config.baseUrl), '/api/tags');
    const body = await fetchJson<OllamaTagsResponse>({
      kind: this.kind,
      url,
      timeoutMs: this.config.discoveryTimeoutMs,
      signal,
    });
    return body.models.map((m): Model => ({
      id: m.name,
      displayName: m.name,
      kind: this.kind,
      source: 'server',
      ...(m.details?.family !== undefined ? { family: m.details.family } : {}),
      ...(m.size !== undefined ? { sizeBytes: m.size } : {}),
      raw: m,
    }));
  }
}
