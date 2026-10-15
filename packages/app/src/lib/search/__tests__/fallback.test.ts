/**
 * fallback.ts — unit tests for FallbackSearchProvider + makeSearchProvider.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FallbackSearchProvider } from '../fallback.js';
import { makeSearchProvider } from '../index.js';
import { SearchError, type SearchProvider, type SearchResult } from '../types.js';

function makeStub(opts: {
  name: string;
  search?: (q: string) => Promise<SearchResult[]>;
  health?: () => Promise<boolean>;
}): SearchProvider {
  return {
    name: opts.name,
    search: opts.search ?? (async () => []),
    health: opts.health ?? (async () => true),
  };
}

function result(url: string, source: 'tavily' | 'brave' | 'duckduckgo' = 'tavily'): SearchResult {
  return { url, title: url, snippet: '', source };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FallbackSearchProvider', () => {
  it('constructor rejects empty provider list', () => {
    expect(() => new FallbackSearchProvider([])).toThrow(SearchError);
  });

  it('returns the first provider\'s results when it succeeds', async () => {
    const a = makeStub({ name: 'a', search: async () => [result('https://a')] });
    const b = makeStub({ name: 'b', search: async () => [result('https://b')] });
    const f = new FallbackSearchProvider([a, b]);
    const out = await f.search('q');
    expect(out).toHaveLength(1);
    expect(out[0]!.url).toBe('https://a');
  });

  it('advances on auth error', async () => {
    const a = makeStub({ name: 'a', search: async () => {
      throw new SearchError('auth', 'no key', 'a');
    } });
    const b = makeStub({ name: 'b', search: async () => [result('https://b', 'brave')] });
    const f = new FallbackSearchProvider([a, b]);
    const out = await f.search('q');
    expect(out[0]!.url).toBe('https://b');
  });

  it('advances on rate-limit error', async () => {
    const a = makeStub({ name: 'a', search: async () => {
      throw new SearchError('rate-limit', '429', 'a');
    } });
    const b = makeStub({ name: 'b', search: async () => [result('https://b')] });
    const f = new FallbackSearchProvider([a, b]);
    const out = await f.search('q');
    expect(out[0]!.url).toBe('https://b');
  });

  it('advances on timeout error', async () => {
    const a = makeStub({ name: 'a', search: async () => {
      throw new SearchError('timeout', 'slow', 'a');
    } });
    const b = makeStub({ name: 'b', search: async () => [result('https://b')] });
    const f = new FallbackSearchProvider([a, b]);
    const out = await f.search('q');
    expect(out[0]!.url).toBe('https://b');
  });

  it('advances on network error', async () => {
    const a = makeStub({ name: 'a', search: async () => {
      throw new SearchError('network', 'ECONN', 'a');
    } });
    const b = makeStub({ name: 'b', search: async () => [result('https://b')] });
    const f = new FallbackSearchProvider([a, b]);
    const out = await f.search('q');
    expect(out[0]!.url).toBe('https://b');
  });

  it('advances on parse error', async () => {
    const a = makeStub({ name: 'a', search: async () => {
      throw new SearchError('parse', 'bad json', 'a');
    } });
    const b = makeStub({ name: 'b', search: async () => [result('https://b')] });
    const f = new FallbackSearchProvider([a, b]);
    const out = await f.search('q');
    expect(out[0]!.url).toBe('https://b');
  });

  it('wraps a non-SearchError and advances', async () => {
    const a = makeStub({ name: 'a', search: async () => { throw new Error('bare'); } });
    const b = makeStub({ name: 'b', search: async () => [result('https://b')] });
    const f = new FallbackSearchProvider([a, b]);
    const out = await f.search('q');
    expect(out[0]!.url).toBe('https://b');
  });

  it('rethrows no-results by default (does not advance)', async () => {
    const a = makeStub({ name: 'a', search: async () => {
      throw new SearchError('no-results', 'zero', 'a');
    } });
    const b = makeStub({ name: 'b', search: async () => [result('https://b')] });
    const f = new FallbackSearchProvider([a, b]);
    await expect(f.search('q')).rejects.toMatchObject({ kind: 'no-results' });
  });

  it('advances on no-results when retryOnEmpty is true', async () => {
    const a = makeStub({ name: 'a', search: async () => {
      throw new SearchError('no-results', 'zero', 'a');
    } });
    const b = makeStub({ name: 'b', search: async () => [result('https://b')] });
    const f = new FallbackSearchProvider([a, b], { retryOnEmpty: true });
    const out = await f.search('q');
    expect(out[0]!.url).toBe('https://b');
  });

  it('re-throws the last error when all providers fail', async () => {
    const a = makeStub({ name: 'a', search: async () => {
      throw new SearchError('auth', 'no key', 'a');
    } });
    const b = makeStub({ name: 'b', search: async () => {
      throw new SearchError('rate-limit', '429', 'b');
    } });
    const f = new FallbackSearchProvider([a, b]);
    await expect(f.search('q')).rejects.toMatchObject({ kind: 'rate-limit', provider: 'b' });
  });

  it('health() returns true if ANY provider is healthy', async () => {
    const a = makeStub({ name: 'a', health: async () => false });
    const b = makeStub({ name: 'b', health: async () => true });
    const f = new FallbackSearchProvider([a, b]);
    expect(await f.health()).toBe(true);
  });

  it('health() returns false if NO provider is healthy', async () => {
    const a = makeStub({ name: 'a', health: async () => false });
    const b = makeStub({ name: 'b', health: async () => false });
    const f = new FallbackSearchProvider([a, b]);
    expect(await f.health()).toBe(false);
  });

  it('health() tolerates a thrown error from a provider', async () => {
    const a = makeStub({ name: 'a', health: async () => { throw new Error('boom'); } });
    const b = makeStub({ name: 'b', health: async () => true });
    const f = new FallbackSearchProvider([a, b]);
    expect(await f.health()).toBe(true);
  });
});

describe('makeSearchProvider', () => {
  it('returns the default provider directly when no fallbackChain is set', () => {
    const p = makeSearchProvider({ default: 'duckduckgo' });
    expect(p.name).toBe('duckduckgo');
  });

  it('throws when default provider has no usable credentials', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => makeSearchProvider({ default: 'tavily' })).toThrow(SearchError);
  });

  it('builds a tavily provider when an apiKey is supplied', () => {
    const p = makeSearchProvider({ default: 'tavily', tavily: { apiKey: 'k' } });
    expect(p.name).toBe('tavily');
  });

  it('builds a fallback chain in order, skipping providers without credentials', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const p = makeSearchProvider({
      default: 'duckduckgo',
      tavily: { apiKey: 'k' },
      // brave has no key — should be skipped
      fallbackChain: ['tavily', 'brave', 'duckduckgo'],
    });
    expect(p.name).toBe('fallback');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('throws when every provider in the chain is unusable', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() =>
      makeSearchProvider({
        default: 'tavily',
        fallbackChain: ['tavily', 'brave'],
      }),
    ).toThrow(SearchError);
  });
});
