/**
 * FallbackSearchProvider — chain wrapper that tries providers in order.
 *
 * Routing rules:
 *   - On `SearchError(kind: 'auth' | 'rate-limit' | 'timeout' | 'network')`,
 *     advance to the next provider in the chain.
 *   - On `SearchError(kind: 'no-results')`:
 *       - if `opts.retryOnEmpty` is true → advance to the next provider,
 *       - otherwise → re-throw (empty results = legitimate answer).
 *   - On `SearchError(kind: 'parse' | 'unknown')` → advance too — these are
 *     provider bugs and the next provider is likely fine.
 *   - On non-SearchError → wrap as `kind: 'unknown'` and advance.
 *   - If every provider fails, re-throw the last error.
 *
 * `health()` reports true if ANY wrapped provider is healthy.
 *
 * Intentionally NO retry-with-backoff inside a single provider — that belongs
 * inside the provider itself (or the caller's higher-level scheduler). This
 * class is pure routing.
 */

import { SearchError, type SearchOptions, type SearchProvider, type SearchResult } from './types.js';

const ADVANCE_KINDS = new Set<string>(['auth', 'rate-limit', 'timeout', 'network', 'parse', 'unknown']);

export interface FallbackOptions {
  /** If true, treat `no-results` from a provider as a failure and advance. */
  retryOnEmpty?: boolean;
}

export class FallbackSearchProvider implements SearchProvider {
  readonly name = 'fallback';
  private readonly providers: readonly SearchProvider[];
  private readonly retryOnEmpty: boolean;

  constructor(providers: readonly SearchProvider[], opts: FallbackOptions = {}) {
    if (providers.length === 0) {
      throw new SearchError('unknown', 'FallbackSearchProvider requires at least one provider', 'fallback');
    }
    this.providers = providers;
    this.retryOnEmpty = opts.retryOnEmpty ?? false;
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    for (const p of this.providers) {
      try {
        const ok = await p.health(signal);
        if (ok) return true;
      } catch {
        // ignore — try next
      }
    }
    return false;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    let lastErr: unknown = new SearchError('unknown', 'No provider attempted', this.name);

    for (const p of this.providers) {
      try {
        return await p.search(query, opts);
      } catch (err) {
        lastErr = err;
        if (err instanceof SearchError) {
          if (err.kind === 'no-results') {
            if (this.retryOnEmpty) continue;
            throw err;
          }
          if (ADVANCE_KINDS.has(err.kind)) continue;
          // Any other kind we don't recognise — advance defensively.
          continue;
        }
        // Non-SearchError → defensive advance.
        continue;
      }
    }

    // All providers exhausted. Re-throw last error, normalising non-SearchError.
    if (lastErr instanceof SearchError) throw lastErr;
    throw new SearchError(
      'unknown',
      lastErr instanceof Error ? lastErr.message : String(lastErr),
      this.name,
      lastErr,
    );
  }
}
