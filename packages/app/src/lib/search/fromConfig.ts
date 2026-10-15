/**
 * buildSearchProviderFromConfig — bridge between the global uplnk config
 * (`config.search`, see lib/config.ts) and the standalone search factory
 * (`makeSearchProvider`, see ./index.ts).
 *
 * This is the "Wave 2 wire-up" the factory's doc comment anticipated. Both
 * deep-research surfaces use it:
 *   - the headless CLI (`uplnk research "<topic>"`), and
 *   - the `@research <topic>` trigger in ChatScreen.
 *
 * Resolution rules:
 *   1. `search.fallbackChain` (when non-empty) wins verbatim.
 *   2. Otherwise `search.default` selects a single provider.
 *   3. Otherwise a chain is auto-built from whichever keys are present —
 *      tavily → brave — with keyless DuckDuckGo appended as a last resort.
 *   4. Nothing configured → `{ ok: false }` with an error NAMING the config
 *      keys, so callers can fail fast with actionable guidance.
 *
 * API keys may come from config (`search.tavily.apiKey`, `search.brave.apiKey`)
 * or, as a headless-friendly fallback, from the TAVILY_API_KEY / BRAVE_API_KEY
 * environment variables.
 */

import type { Config } from '../config.js';
import {
  makeSearchProvider,
  type SearchProvider,
  type SearchProviderName,
} from './index.js';

/** Human-readable pointer used in every failure message. */
export const SEARCH_CONFIG_HINT =
  'Set `search.tavily.apiKey` or `search.brave.apiKey` in ~/.uplnk/config.json ' +
  '(or export TAVILY_API_KEY / BRAVE_API_KEY), or opt into keyless DuckDuckGo ' +
  'with `search.default: "duckduckgo"`.';

export type SearchFromConfigResult =
  | { ok: true; provider: SearchProvider; chain: readonly SearchProviderName[] }
  | { ok: false; error: string };

export function buildSearchProviderFromConfig(
  search: Config['search'],
): SearchFromConfigResult {
  const tavilyKey = search.tavily?.apiKey ?? process.env['TAVILY_API_KEY'];
  const braveKey = search.brave?.apiKey ?? process.env['BRAVE_API_KEY'];

  let chain: SearchProviderName[];
  if (search.fallbackChain.length > 0) {
    chain = [...search.fallbackChain];
  } else if (search.default !== undefined) {
    chain = [search.default];
  } else {
    chain = [];
    if (tavilyKey !== undefined && tavilyKey !== '') chain.push('tavily');
    if (braveKey !== undefined && braveKey !== '') chain.push('brave');
    // Keyless last resort — only when the user configured at least one keyed
    // provider. With NOTHING configured we fail fast instead of silently
    // scraping DuckDuckGo.
    if (chain.length > 0) chain.push('duckduckgo');
  }

  if (chain.length === 0) {
    return {
      ok: false,
      error: `no search provider configured. ${SEARCH_CONFIG_HINT}`,
    };
  }

  try {
    const provider = makeSearchProvider({
      default: chain[0]!,
      ...(tavilyKey !== undefined && tavilyKey !== '' ? { tavily: { apiKey: tavilyKey } } : {}),
      ...(braveKey !== undefined && braveKey !== '' ? { brave: { apiKey: braveKey } } : {}),
      ...(chain.length > 1 ? { fallbackChain: chain } : {}),
    });
    return { ok: true, provider, chain };
  } catch (err) {
    return {
      ok: false,
      error: `${err instanceof Error ? err.message : String(err)}. ${SEARCH_CONFIG_HINT}`,
    };
  }
}
