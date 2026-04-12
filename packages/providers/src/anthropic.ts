import { fetchJson, joinUrl } from './base.js';
import { ProviderError } from './errors.js';
import type { ModelProvider, ProviderConfig, Model, HealthStatus } from './types.js';

interface AnthropicModelsResponse {
  data: Array<{
    id: string;
    display_name?: string;
    type?: string;
    created_at?: string;
  }>;
}

/**
 * Anthropic exposes `/v1/models` (2024-06+). Auth is `x-api-key`, not bearer.
 * Older proxies may 404; catalog fallback fills the gap at the merge layer.
 */
export class AnthropicProvider implements ModelProvider {
  readonly kind = 'anthropic' as const;
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
    if (this.config.apiKey === undefined || this.config.apiKey === '') {
      throw new ProviderError('AUTH_FAILED', this.kind, 'Anthropic API key required');
    }
    const url = joinUrl(this.config.baseUrl, '/v1/models');
    const body = await fetchJson<AnthropicModelsResponse>({
      kind: this.kind,
      url,
      headers: {
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      timeoutMs: this.config.discoveryTimeoutMs,
      signal,
    });
    return body.data.map((m): Model => ({
      id: m.id,
      displayName: m.display_name ?? m.id,
      kind: this.kind,
      source: 'server',
      raw: m,
    }));
  }
}
