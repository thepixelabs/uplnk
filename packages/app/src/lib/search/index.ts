/**
 * Public surface of the search provider package.
 *
 * Phase D consumers should import types + the factory:
 *
 *     import { makeSearchProvider, type SearchProvider } from '../search/index.js';
 *
 * The factory composes a single `SearchProvider` from a config record.
 * Direct provider construction (e.g. `new TavilyProvider({ apiKey })`) is
 * also exported for tests and any caller that doesn't want fallback routing.
 */

export {
  DEFAULT_SEARCH_COUNT,
  DEFAULT_SEARCH_TIMEOUT_MS,
  SearchError,
  type SearchErrorKind,
  type SearchOptions,
  type SearchProvider,
  type SearchProviderName,
  type SearchResult,
} from './types.js';

export { TavilyProvider, type TavilyProviderOptions } from './tavily.js';
export { BraveProvider, type BraveProviderOptions } from './brave.js';
export { DuckDuckGoProvider, type DuckDuckGoProviderOptions } from './duckduckgo.js';
export { FallbackSearchProvider, type FallbackOptions } from './fallback.js';

import { BraveProvider } from './brave.js';
import { DuckDuckGoProvider } from './duckduckgo.js';
import { FallbackSearchProvider } from './fallback.js';
import { TavilyProvider } from './tavily.js';
import { SearchError, type SearchProvider, type SearchProviderName } from './types.js';

/**
 * Config record for `makeSearchProvider`. Wire-up into the global uplnk
 * config schema happens in Wave 2; this is the standalone shape Phase D
 * code can pass directly without depending on `lib/config.ts`.
 *
 * `default` is required so we always know which provider to instantiate
 * when no `fallbackChain` is given. `fallbackChain`, when set, builds a
 * `FallbackSearchProvider` from the listed names (skipping any that have
 * no usable credentials, with a warning).
 */
export interface SearchProviderConfig {
  default: SearchProviderName;
  tavily?: { apiKey: string };
  brave?: { apiKey: string };
  fallbackChain?: readonly SearchProviderName[];
}

function buildOne(name: SearchProviderName, cfg: SearchProviderConfig): SearchProvider | null {
  switch (name) {
    case 'tavily': {
      const key = cfg.tavily?.apiKey;
      if (key === undefined || key === '') {
        console.warn('[search] tavily requested but no apiKey configured — skipping');
        return null;
      }
      return new TavilyProvider({ apiKey: key });
    }
    case 'brave': {
      const key = cfg.brave?.apiKey;
      if (key === undefined || key === '') {
        console.warn('[search] brave requested but no apiKey configured — skipping');
        return null;
      }
      return new BraveProvider({ apiKey: key });
    }
    case 'duckduckgo':
      return new DuckDuckGoProvider();
  }
}

/**
 * Build a single `SearchProvider` from a config record.
 *
 * Behaviour:
 *   - If `fallbackChain` is unset → return the `default` provider directly.
 *   - If `fallbackChain` is set → build a `FallbackSearchProvider` in chain
 *     order. Providers whose credentials are missing are skipped with a
 *     console.warn. If NO provider remains usable, throw.
 *
 * The factory does not de-duplicate the chain — callers can intentionally
 * list the same provider twice if they want a "try, then try again" effect
 * with a refreshed key, but that's their choice.
 */
export function makeSearchProvider(cfg: SearchProviderConfig): SearchProvider {
  if (cfg.fallbackChain === undefined || cfg.fallbackChain.length === 0) {
    const one = buildOne(cfg.default, cfg);
    if (one === null) {
      throw new SearchError(
        'auth',
        `default search provider '${cfg.default}' has no usable credentials`,
        'factory',
      );
    }
    return one;
  }

  const built: SearchProvider[] = [];
  for (const name of cfg.fallbackChain) {
    const provider = buildOne(name, cfg);
    if (provider !== null) built.push(provider);
  }
  if (built.length === 0) {
    throw new SearchError(
      'auth',
      'fallbackChain has no usable providers (every entry is missing credentials)',
      'factory',
    );
  }
  return new FallbackSearchProvider(built);
}
