/**
 * Search provider abstraction — interface, result/options shape, error type.
 *
 * Phase D foundation: the same `SearchProvider` contract is consumed by the
 * Deep Research runner (D.2.1), the `/search` tool (Phase F polish), and any
 * future "fetch a URL and summarise" sub-tasks. Implementations live alongside
 * (tavily.ts, brave.ts, duckduckgo.ts, fallback.ts) and are stitched together
 * through the `makeSearchProvider` factory in index.ts.
 *
 * The contract is intentionally narrow:
 *   - one `search(query, opts)` async call returning a flat `SearchResult[]`,
 *   - one `health(signal?)` probe that should not throw,
 *   - one `name` identifier the runner can log.
 *
 * Implementations MUST throw `SearchError` (never bare `Error`) so the
 * fallback chain can branch on `kind` without parsing messages. Empty result
 * sets are modelled as `kind: 'no-results'` rather than `[]` so the chain can
 * decide whether to advance to the next provider.
 */

/** Provider identifier emitted on every result. */
export type SearchProviderName = 'tavily' | 'brave' | 'duckduckgo';

/** Single search hit. Fields the provider omits are absent, never `null`. */
export interface SearchResult {
  /** Full URL — required, validated http(s). */
  url: string;
  /** Page title. Empty string if the provider omits it. */
  title: string;
  /** Short excerpt or description. Empty string if absent. */
  snippet: string;
  /** Pre-extracted full content if the provider returns it (Tavily). */
  content?: string;
  /** Provider relevance score 0–1 if available. */
  score?: number;
  /** Publication date if available — ISO 8601 string. */
  publishedAt?: string;
  /** Which provider returned this result. */
  source: SearchProviderName;
}

/** Caller-tunable knobs. Implementations ignore fields they cannot honour. */
export interface SearchOptions {
  /** Max results to return. Provider may return fewer. Default 10. */
  count?: number;
  /** Time-range filter. `undefined` = no filter (all time). */
  timeRange?: 'day' | 'week' | 'month' | 'year';
  /** Domain include allowlist (Tavily-supported). */
  includeDomains?: readonly string[];
  /** Domain exclude blocklist (Tavily-supported). */
  excludeDomains?: readonly string[];
  /** External abort signal. Composes with the internal timeout. */
  signal?: AbortSignal;
  /** Hard timeout in ms. Default 10_000. */
  timeoutMs?: number;
}

export interface SearchProvider {
  /** Short identifier — 'tavily' | 'brave' | 'duckduckgo' | 'fallback'. */
  readonly name: string;
  /** Cheap health check — typically a 1-result query against a known term. */
  health(signal?: AbortSignal): Promise<boolean>;
  /** Perform the search. MUST throw `SearchError` on failure. */
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
}

/**
 * Reason a `search()` call failed. The `FallbackSearchProvider` chain branches
 * on this discriminator to decide whether to advance to the next provider.
 *
 *   - `auth`        — 401/403, missing or rejected API key.
 *   - `rate-limit`  — 429 or provider-specific quota response.
 *   - `timeout`     — internal timeout or external AbortSignal fired.
 *   - `network`     — fetch rejected (DNS, ECONNREFUSED, etc.).
 *   - `parse`       — response did not match expected JSON / HTML shape.
 *   - `no-results`  — request succeeded but returned zero hits.
 *   - `unknown`     — anything we don't have a more specific bucket for.
 */
export type SearchErrorKind =
  | 'auth'
  | 'rate-limit'
  | 'timeout'
  | 'network'
  | 'parse'
  | 'no-results'
  | 'unknown';

export class SearchError extends Error {
  readonly kind: SearchErrorKind;
  readonly provider: string;
  readonly cause?: unknown;

  constructor(
    kind: SearchErrorKind,
    message: string,
    provider: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'SearchError';
    this.kind = kind;
    this.provider = provider;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Default timeout if the caller does not supply one. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 10_000;
/** Default result count if the caller does not supply one. */
export const DEFAULT_SEARCH_COUNT = 10;
