/**
 * BraveProvider — search via the Brave Search API.
 *
 * Brave is the mid-tier: ranked results with descriptions and "age" hints, but
 * no pre-extracted full content. Requires an API key from
 * https://api.search.brave.com/app/dashboard.
 *
 * Endpoint: GET https://api.search.brave.com/res/v1/web/search?q=...&count=...
 *   Headers : X-Subscription-Token: <apiKey>, Accept: application/json
 *   200     : { web: { results: [{ url, title, description, age, ... }] } }
 *   401/403 → auth
 *   429     → rate-limit
 *   5xx     → unknown
 *
 * `timeRange` maps to Brave's `freshness` parameter (`pd`/`pw`/`pm`/`py`).
 * Domain include / exclude are not supported by Brave — the caller's hints
 * are silently ignored (documented; no warning to avoid log spam).
 */

import {
  DEFAULT_SEARCH_COUNT,
  DEFAULT_SEARCH_TIMEOUT_MS,
  SearchError,
  type SearchOptions,
  type SearchProvider,
  type SearchResult,
} from './types.js';

interface BraveHit {
  url?: unknown;
  title?: unknown;
  description?: unknown;
  age?: unknown;
}

interface BraveResponse {
  web?: { results?: BraveHit[] };
}

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const PROVIDER_NAME = 'brave';

function mapFreshness(value: SearchOptions['timeRange']): string | undefined {
  switch (value) {
    case 'day':
      return 'pd';
    case 'week':
      return 'pw';
    case 'month':
      return 'pm';
    case 'year':
      return 'py';
    case undefined:
      return undefined;
  }
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function parseHits(hits: BraveHit[]): SearchResult[] {
  const out: SearchResult[] = [];
  for (const hit of hits) {
    if (!isString(hit.url) || hit.url === '') continue;
    const result: SearchResult = {
      url: hit.url,
      title: isString(hit.title) ? hit.title : '',
      snippet: isString(hit.description) ? hit.description : '',
      source: 'brave',
    };
    if (isString(hit.age) && hit.age !== '') result.publishedAt = hit.age;
    out.push(result);
  }
  return out;
}

export interface BraveProviderOptions {
  apiKey: string;
  baseUrl?: string;
}

export class BraveProvider implements SearchProvider {
  readonly name = PROVIDER_NAME;
  private readonly apiKey: string;
  private readonly endpoint: string;

  constructor(opts: BraveProviderOptions) {
    if (opts.apiKey === '') {
      throw new SearchError('auth', 'BraveProvider: apiKey required', PROVIDER_NAME);
    }
    this.apiKey = opts.apiKey;
    this.endpoint = opts.baseUrl ?? ENDPOINT;
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    try {
      const results = await this.search('hello', { count: 1, ...(signal ? { signal } : {}) });
      return results.length > 0;
    } catch {
      return false;
    }
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
    const count = opts.count ?? DEFAULT_SEARCH_COUNT;
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
    const onExternalAbort = (): void => { controller.abort(); };
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const params = new URLSearchParams({ q: query, count: String(count) });
    const freshness = mapFreshness(opts.timeRange);
    if (freshness !== undefined) params.set('freshness', freshness);
    const url = `${this.endpoint}?${params.toString()}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          'X-Subscription-Token': this.apiKey,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new SearchError('timeout', `Brave request timed out after ${String(timeoutMs)}ms`, PROVIDER_NAME, err);
      }
      throw new SearchError('network', err instanceof Error ? err.message : String(err), PROVIDER_NAME, err);
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort);
    }

    if (res.status === 401 || res.status === 403) {
      throw new SearchError('auth', `Brave auth failed (HTTP ${String(res.status)})`, PROVIDER_NAME);
    }
    if (res.status === 429) {
      throw new SearchError('rate-limit', 'Brave rate-limited (HTTP 429)', PROVIDER_NAME);
    }
    if (!res.ok) {
      throw new SearchError('unknown', `Brave HTTP ${String(res.status)}`, PROVIDER_NAME);
    }

    let parsed: BraveResponse;
    try {
      parsed = (await res.json()) as BraveResponse;
    } catch (err) {
      throw new SearchError('parse', 'Brave response was not valid JSON', PROVIDER_NAME, err);
    }

    const hits = parsed.web?.results;
    if (!Array.isArray(hits)) {
      throw new SearchError('parse', 'Brave response missing `web.results` array', PROVIDER_NAME);
    }
    const results = parseHits(hits);
    if (results.length === 0) {
      throw new SearchError('no-results', `Brave returned 0 results for "${query}"`, PROVIDER_NAME);
    }
    return results;
  }
}
