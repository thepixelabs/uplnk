import { fetchJson, joinUrl, authHeaders } from './base.js';
import type { ModelProvider, ProviderConfig, Model, HealthStatus } from './types.js';

interface OpenAIModelsResponse {
  data: Array<{
    id: string;
    object?: string;
    created?: number;
    owned_by?: string;
  }>;
}

/**
 * OpenAI-compatible discovery — shared by LM Studio, vLLM, LocalAI,
 * llama.cpp server, LiteLLM proxy, and generic custom endpoints.
 *
 * All of them respond to GET {baseUrl}/v1/models with the same shape.
 * If the supplied `baseUrl` already ends in `/v1`, we don't double it.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  constructor(
    readonly kind: ProviderConfig['kind'],
    readonly config: ProviderConfig,
  ) {}

  private modelsUrl(): string {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const suffix = /\/v1$/i.test(base) ? '/models' : '/v1/models';
    return joinUrl(base, suffix);
  }

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
    const body = await fetchJson<OpenAIModelsResponse>({
      kind: this.kind,
      url: this.modelsUrl(),
      headers: authHeaders(this.config.authMode, this.config.apiKey, 'bearer'),
      timeoutMs: this.config.discoveryTimeoutMs,
      signal,
    });
    return body.data.map((m): Model => ({
      id: m.id,
      displayName: m.id,
      kind: this.kind,
      source: 'server',
      raw: m,
    }));
  }
}
