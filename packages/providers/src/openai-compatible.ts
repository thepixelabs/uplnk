import { fetchJson, joinUrl, authHeaders } from './base.js';
import { ProviderError } from './errors.js';
import type { ModelProvider, ProviderConfig, Model, HealthStatus } from './types.js';

/**
 * Wire shape of /v1/models. Servers may expose extra context fields:
 *   - vLLM emits `max_model_len`.
 *   - Some llama.cpp / LiteLLM / LM Studio builds emit `context_length`.
 * Fields not present on the wire are simply absent here — we never invent one.
 */
interface OpenAIModelsResponse {
  data: Array<{
    id: string;
    object?: string;
    created?: number;
    owned_by?: string;
    context_length?: number;
    max_model_len?: number;
    max_context_length?: number;
  }>;
}

/** llama.cpp server /slots response — array of slot objects. */
interface LlamaCppSlotsResponse {
  // Other slot fields exist but we only need n_ctx; keep the shape narrow.
  0?: { n_ctx?: number };
  length?: number;
}

/**
 * OpenAI-compatible discovery — shared by LM Studio, vLLM, LocalAI,
 * llama.cpp server, LiteLLM proxy, and generic custom endpoints.
 *
 * All of them respond to GET {baseUrl}/v1/models with the same shape.
 * If the supplied `baseUrl` already ends in `/v1`, we don't double it.
 *
 * Some servers also expose live context-window info — see `extractContextWindow`
 * and the llama.cpp `/slots` probe below. Anything we read from the wire wins
 * over the static catalog at merge time (see `merge.ts`).
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

  /** llama.cpp `/slots` is served at the native root, not under /v1. */
  private slotsUrl(): string {
    const base = this.config.baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
    return joinUrl(base, '/slots');
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

    // llama.cpp users frequently run with a custom `-c N` flag that diverges
    // from the catalog's stated max. Probe /slots once and apply n_ctx to every
    // model since llama-server only ever serves one model anyway. 404 and
    // connection errors are treated as "no signal" — catalog wins downstream.
    const slotsNCtx =
      this.kind === 'llama-cpp' ? await this.probeLlamaCppSlots(signal) : undefined;

    return body.data.map((m): Model => {
      const wireCtx = extractContextWindow(m);
      const contextWindow = slotsNCtx ?? wireCtx;
      return {
        id: m.id,
        displayName: m.id,
        kind: this.kind,
        source: 'server',
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        raw: m,
      };
    });
  }

  private async probeLlamaCppSlots(signal?: AbortSignal): Promise<number | undefined> {
    try {
      const slots = await fetchJson<LlamaCppSlotsResponse>({
        kind: this.kind,
        url: this.slotsUrl(),
        headers: authHeaders(this.config.authMode, this.config.apiKey, 'bearer'),
        timeoutMs: this.config.discoveryTimeoutMs,
        signal,
      });
      // Response is an array; treat both `[{n_ctx}]` and `{0: {n_ctx}}` shapes.
      const slot0 = Array.isArray(slots) ? (slots as Array<{ n_ctx?: number }>)[0] : slots[0];
      const nCtx = slot0?.n_ctx;
      return typeof nCtx === 'number' && nCtx > 0 ? nCtx : undefined;
    } catch (err) {
      // 404 (older server), UNREACHABLE, TIMEOUT → graceful "no signal".
      if (err instanceof ProviderError) return undefined;
      return undefined;
    }
  }
}

/**
 * Pick the first numeric context-window field present on a /v1/models entry.
 * Precedence: max_model_len (vLLM) → context_length → max_context_length.
 * Returns undefined when no field is present so the catalog merge can decide.
 */
function extractContextWindow(m: {
  context_length?: number;
  max_model_len?: number;
  max_context_length?: number;
}): number | undefined {
  if (typeof m.max_model_len === 'number' && m.max_model_len > 0) return m.max_model_len;
  if (typeof m.context_length === 'number' && m.context_length > 0) return m.context_length;
  if (typeof m.max_context_length === 'number' && m.max_context_length > 0) return m.max_context_length;
  return undefined;
}
