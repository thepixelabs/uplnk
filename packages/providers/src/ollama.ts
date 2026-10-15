import { fetchJson, joinUrl, authHeaders } from './base.js';
import { ProviderError } from './errors.js';
import type { ModelProvider, ProviderConfig, Model, HealthStatus } from './types.js';

/** A single NDJSON line from Ollama's POST /api/pull stream. */
export interface OllamaPullEvent {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

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
 * Ollama /api/show response. Two places carry context info:
 *   - `model_info`: a record keyed by `<arch>.context_length` (e.g.
 *     `llama.context_length`, `qwen2.context_length`). Reported when the model
 *     was loaded recently enough that Ollama has parsed the GGUF metadata.
 *   - `parameters`: a newline-separated string like "num_ctx 8192\nstop ..."
 *     reflecting Modelfile overrides. Takes precedence over `model_info` when
 *     present because it represents the user's explicit ctx override.
 */
interface OllamaShowResponse {
  modelfile?: string;
  parameters?: string;
  template?: string;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
  model_info?: Record<string, unknown>;
}

/**
 * Lazy model-detail result. Populated only with fields /api/show actually
 * reports — undefined values are intentional so the caller can fall back to
 * the catalog without overriding live data.
 */
export interface OllamaModelDetail {
  id: string;
  contextWindow?: number;
  family?: string;
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

  /**
   * Lists models from /api/tags. Context window is *not* on this endpoint —
   * use `getModelDetail` for that. We deliberately keep `contextWindow`
   * undefined here so the catalog merge layer fills the gap; calling
   * /api/show per model would be N requests per probe (≤20 models today, but
   * unscalable as users add more).
   */
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

  /**
   * Stream the pull of a model from the Ollama registry.
   *
   * Yields OllamaPullEvent NDJSON lines as they arrive. The final event has
   * `status === 'success'`. The generator returns normally on success and
   * throws on HTTP errors or AbortError on cancellation.
   */
  async *pullModel(
    modelId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<OllamaPullEvent, void, unknown> {
    const url = joinUrl(nativeRoot(this.config.baseUrl), '/api/pull');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...authHeaders(this.config.authMode, this.config.apiKey),
    };
    const res = await fetch(
      url,
      signal !== undefined
        ? { method: 'POST', headers, body: JSON.stringify({ name: modelId, stream: true }), signal }
        : { method: 'POST', headers, body: JSON.stringify({ name: modelId, stream: true }) },
    );
    if (!res.ok || res.body === null) {
      throw new ProviderError('SERVER_ERROR', this.kind, `Pull failed: HTTP ${String(res.status)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line === '') continue;
          try { yield JSON.parse(line) as OllamaPullEvent; } catch { /* skip malformed */ }
        }
      }
      if (buf.trim() !== '') {
        try { yield JSON.parse(buf.trim()) as OllamaPullEvent; } catch { /* ignore */ }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Fetch live context window for one model via POST /api/show.
   * Called lazily on model selection — NOT in the listModels path.
   *
   * Returns undefined `contextWindow` when neither `parameters num_ctx` nor a
   * `<arch>.context_length` key is present so the catalog merge layer can
   * decide. 404 / UNREACHABLE / TIMEOUT also resolve to no-signal so callers
   * can render whatever the catalog had without surfacing an error.
   */
  async getModelDetail(
    modelId: string,
    signal?: AbortSignal,
  ): Promise<OllamaModelDetail> {
    const url = joinUrl(nativeRoot(this.config.baseUrl), '/api/show');
    let body: OllamaShowResponse;
    try {
      body = await fetchJson<OllamaShowResponse>({
        kind: this.kind,
        url,
        method: 'POST',
        body: { name: modelId },
        timeoutMs: this.config.discoveryTimeoutMs,
        signal,
      });
    } catch (err) {
      if (err instanceof ProviderError) return { id: modelId };
      throw err;
    }

    const contextWindow =
      parseNumCtxFromParameters(body.parameters) ??
      extractContextFromModelInfo(body.model_info);
    const family = body.details?.family;

    return {
      id: modelId,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(family !== undefined ? { family } : {}),
    };
  }
}

/**
 * Parse Ollama's `parameters` blob (a newline-separated key/value string set
 * via Modelfile) for `num_ctx <int>`. Values <= 0 are treated as missing.
 */
function parseNumCtxFromParameters(parameters: string | undefined): number | undefined {
  if (parameters === undefined || parameters === '') return undefined;
  // Match `num_ctx 8192` or `num_ctx    8192`; reject anything non-numeric.
  const match = /(?:^|\n)\s*num_ctx\s+(\d+)\s*(?:$|\n)/.exec(parameters);
  if (match === null) return undefined;
  const raw = match[1];
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Walk model_info for any key ending in `.context_length`. Different
 * architectures use different prefixes (`llama.context_length`,
 * `qwen2.context_length`, `gemma2.context_length`, …) — we accept any.
 */
function extractContextFromModelInfo(
  info: Record<string, unknown> | undefined,
): number | undefined {
  if (info === undefined) return undefined;
  for (const [key, value] of Object.entries(info)) {
    if (!key.endsWith('.context_length')) continue;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}
