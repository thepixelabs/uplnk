/**
 * TavilyProvider — search via the Tavily Search API (https://tavily.com).
 *
 * Tavily is the premium path: ranked results, pre-extracted content (so the
 * deep-research extractor doesn't need a follow-up fetch), domain include /
 * exclude filters, time-range filter. Requires an API key.
 *
 * Endpoint: POST https://api.tavily.com/search
 *   Body  : { api_key, query, max_results, search_depth: 'advanced',
 *             include_answer: false, time_range?, include_domains?, exclude_domains? }
 *   200   : { results: [{ url, title, content, score, published_date }] }
 *   401/403 → auth
 *   429    → rate-limit
 *   5xx    → unknown (we do not retry; the fallback chain advances)
 *
 * Mapping: `content` is the pre-extracted body. We expose it as both
 * `snippet` (first 200 chars) and `content` (full text) so the runner can
 * choose between them without re-fetching.
 */

import {
  DEFAULT_SEARCH_COUNT,
  DEFAULT_SEARCH_TIMEOUT_MS,
  SearchError,
  type SearchOptions,
  type SearchProvider,
  type SearchResult,
} from './types.js';

interface TavilyHit {
  url?: unknown;
  title?: unknown;
  content?: unknown;
  score?: unknown;
  published_date?: unknown;
}

interface TavilyResponse {
  results?: TavilyHit[];
}

const SNIPPET_MAX_CHARS = 200;
const ENDPOINT = 'https://api.tavily.com/search';
const PROVIDER_NAME = 'tavily';

function mapTimeRange(value: SearchOptions['timeRange']): string | undefined {
  switch (value) {
    case 'day':
      return 'd';
    case 'week':
      return 'w';
    case 'month':
      return 'm';
    case 'year':
      return 'y';
    case undefined:
      return undefined;
  }
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function clipSnippet(content: string): string {
  if (content.length <= SNIPPET_MAX_CHARS) return content;
  return content.slice(0, SNIPPET_MAX_CHARS);
}

function parseHits(hits: TavilyHit[]): SearchResult[] {
  const out: SearchResult[] = [];
  for (const hit of hits) {
    if (!isString(hit.url) || hit.url === '') continue;
    const content = isString(hit.content) ? hit.content : '';
    const title = isString(hit.title) ? hit.title : '';
    const result: SearchResult = {
      url: hit.url,
      title,
      snippet: clipSnippet(content),
      source: 'tavily',
    };
    if (content !== '') result.content = content;
    if (typeof hit.score === 'number') result.score = hit.score;
    if (isString(hit.published_date) && hit.published_date !== '') {
      result.publishedAt = hit.published_date;
    }
    out.push(result);
  }
  return out;
}

export interface TavilyProviderOptions {
  apiKey: string;
  baseUrl?: string;
}

export class TavilyProvider implements SearchProvider {
  readonly name = PROVIDER_NAME;
  private readonly apiKey: string;
  private readonly endpoint: string;

  constructor(opts: TavilyProviderOptions) {
    if (opts.apiKey === '') {
      throw new SearchError('auth', 'TavilyProvider: apiKey required', PROVIDER_NAME);
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

    const body: Record<string, unknown> = {
      api_key: this.apiKey,
      query,
      max_results: count,
      search_depth: 'advanced',
      include_answer: false,
    };
    const timeRange = mapTimeRange(opts.timeRange);
    if (timeRange !== undefined) body['time_range'] = timeRange;
    if (opts.includeDomains && opts.includeDomains.length > 0) {
      body['include_domains'] = [...opts.includeDomains];
    }
    if (opts.excludeDomains && opts.excludeDomains.length > 0) {
      body['exclude_domains'] = [...opts.excludeDomains];
    }

    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new SearchError('timeout', `Tavily request timed out after ${String(timeoutMs)}ms`, PROVIDER_NAME, err);
      }
      throw new SearchError('network', err instanceof Error ? err.message : String(err), PROVIDER_NAME, err);
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort);
    }

    if (res.status === 401 || res.status === 403) {
      throw new SearchError('auth', `Tavily auth failed (HTTP ${String(res.status)})`, PROVIDER_NAME);
    }
    if (res.status === 429) {
      throw new SearchError('rate-limit', 'Tavily rate-limited (HTTP 429)', PROVIDER_NAME);
    }
    if (!res.ok) {
      throw new SearchError('unknown', `Tavily HTTP ${String(res.status)}`, PROVIDER_NAME);
    }

    let parsed: TavilyResponse;
    try {
      parsed = (await res.json()) as TavilyResponse;
    } catch (err) {
      throw new SearchError('parse', 'Tavily response was not valid JSON', PROVIDER_NAME, err);
    }
    if (!Array.isArray(parsed.results)) {
      throw new SearchError('parse', 'Tavily response missing `results` array', PROVIDER_NAME);
    }

    const results = parseHits(parsed.results);
    if (results.length === 0) {
      throw new SearchError('no-results', `Tavily returned 0 results for "${query}"`, PROVIDER_NAME);
    }
    return results;
  }
}
