/**
 * fromConfig — tests for buildSearchProviderFromConfig, the bridge between
 * `config.search` and the makeSearchProvider factory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildSearchProviderFromConfig, SEARCH_CONFIG_HINT } from '../fromConfig.js';
import { FallbackSearchProvider } from '../fallback.js';
import type { Config } from '../../config.js';

type SearchCfg = Config['search'];

function makeSearchCfg(overrides: Partial<SearchCfg> = {}): SearchCfg {
  return { fallbackChain: [], ...overrides };
}

const ENV_KEYS = ['TAVILY_API_KEY', 'BRAVE_API_KEY'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('buildSearchProviderFromConfig', () => {
  it('fails fast with the config keys named when nothing is configured', () => {
    const result = buildSearchProviderFromConfig(makeSearchCfg());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('no search provider configured');
    expect(result.error).toContain('search.tavily.apiKey');
    expect(result.error).toContain('search.brave.apiKey');
    expect(result.error).toContain('duckduckgo');
  });

  it('supports keyless DuckDuckGo via search.default', () => {
    const result = buildSearchProviderFromConfig(makeSearchCfg({ default: 'duckduckgo' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chain).toEqual(['duckduckgo']);
    expect(result.provider.name).toBe('duckduckgo');
  });

  it('auto-builds a tavily → duckduckgo chain from a configured tavily key', () => {
    const result = buildSearchProviderFromConfig(
      makeSearchCfg({ tavily: { apiKey: 'tvly-test' } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chain).toEqual(['tavily', 'duckduckgo']);
    expect(result.provider).toBeInstanceOf(FallbackSearchProvider);
  });

  it('auto-builds tavily → brave → duckduckgo when both keys are present', () => {
    const result = buildSearchProviderFromConfig(
      makeSearchCfg({ tavily: { apiKey: 't' }, brave: { apiKey: 'b' } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chain).toEqual(['tavily', 'brave', 'duckduckgo']);
  });

  it('an explicit fallbackChain wins over the auto-built chain', () => {
    const result = buildSearchProviderFromConfig(
      makeSearchCfg({
        tavily: { apiKey: 't' },
        fallbackChain: ['duckduckgo'],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chain).toEqual(['duckduckgo']);
  });

  it('falls back to TAVILY_API_KEY from the environment', () => {
    process.env['TAVILY_API_KEY'] = 'tvly-env';
    const result = buildSearchProviderFromConfig(makeSearchCfg());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chain).toEqual(['tavily', 'duckduckgo']);
  });

  it('a keyed default without a usable key surfaces the factory error plus the hint', () => {
    const result = buildSearchProviderFromConfig(makeSearchCfg({ default: 'tavily' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('tavily');
    expect(result.error).toContain(SEARCH_CONFIG_HINT);
  });
});
