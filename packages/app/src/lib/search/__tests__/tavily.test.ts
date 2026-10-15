/**
 * tavily.ts — unit tests for TavilyProvider.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TavilyProvider } from '../tavily.js';
import { SearchError } from '../types.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const VALID_BODY = {
  results: [
    {
      url: 'https://example.com/a',
      title: 'Example A',
      content: 'Aaa '.repeat(80), // > 200 chars
      score: 0.91,
      published_date: '2026-01-01',
    },
    {
      url: 'https://example.com/b',
      title: 'Example B',
      content: 'Short content',
      score: 0.42,
    },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TavilyProvider', () => {
  it('constructor rejects empty apiKey', () => {
    expect(() => new TavilyProvider({ apiKey: '' })).toThrow(SearchError);
  });

  it('maps a happy-path response to SearchResult[] with snippet and content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(VALID_BODY)));
    const p = new TavilyProvider({ apiKey: 'k' });
    const out = await p.search('hello');
    expect(out).toHaveLength(2);
    expect(out[0]!.url).toBe('https://example.com/a');
    expect(out[0]!.title).toBe('Example A');
    expect(out[0]!.snippet.length).toBe(200);
    expect(out[0]!.content).toBe(VALID_BODY.results[0]!.content);
    expect(out[0]!.score).toBe(0.91);
    expect(out[0]!.publishedAt).toBe('2026-01-01');
    expect(out[0]!.source).toBe('tavily');
    // b has no published_date
    expect(out[1]!.publishedAt).toBeUndefined();
  });

  it('sends search_depth=advanced and maps timeRange/include/exclude in body', async () => {
    const fetchSpy = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => jsonResponse(VALID_BODY),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const p = new TavilyProvider({ apiKey: 'kk' });
    await p.search('q', {
      count: 4,
      timeRange: 'week',
      includeDomains: ['a.com'],
      excludeDomains: ['b.com'],
    });
    const call = fetchSpy.mock.calls[0]!;
    expect(call[0]).toBe('https://api.tavily.com/search');
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent['api_key']).toBe('kk');
    expect(sent['query']).toBe('q');
    expect(sent['max_results']).toBe(4);
    expect(sent['search_depth']).toBe('advanced');
    expect(sent['include_answer']).toBe(false);
    expect(sent['time_range']).toBe('w');
    expect(sent['include_domains']).toEqual(['a.com']);
    expect(sent['exclude_domains']).toEqual(['b.com']);
  });

  it('throws no-results when response.results is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [] })));
    const p = new TavilyProvider({ apiKey: 'k' });
    await expect(p.search('q')).rejects.toMatchObject({ kind: 'no-results', provider: 'tavily' });
  });

  it('throws no-results when all entries lack url', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [{ title: 'no url' }] })));
    const p = new TavilyProvider({ apiKey: 'k' });
    await expect(p.search('q')).rejects.toMatchObject({ kind: 'no-results' });
  });

  it('throws auth on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    const p = new TavilyProvider({ apiKey: 'k' });
    await expect(p.search('q')).rejects.toMatchObject({ kind: 'auth', provider: 'tavily' });
  });

  it('throws auth on 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    const p = new TavilyProvider({ apiKey: 'k' });
    await expect(p.search('q')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('throws rate-limit on 429', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })));
    const p = new TavilyProvider({ apiKey: 'k' });
    await expect(p.search('q')).rejects.toMatchObject({ kind: 'rate-limit' });
  });

  it('throws timeout when an external AbortSignal fires', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }));
    const p = new TavilyProvider({ apiKey: 'k' });
    const ctrl = new AbortController();
    const pending = p.search('q', { signal: ctrl.signal, timeoutMs: 5000 });
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('throws timeout when the internal timer fires', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }));
    const p = new TavilyProvider({ apiKey: 'k' });
    await expect(p.search('q', { timeoutMs: 5 })).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('throws parse on malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('not-json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ));
    const p = new TavilyProvider({ apiKey: 'k' });
    await expect(p.search('q')).rejects.toMatchObject({ kind: 'parse' });
  });

  it('throws parse when results field is not an array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: 'oops' })));
    const p = new TavilyProvider({ apiKey: 'k' });
    await expect(p.search('q')).rejects.toMatchObject({ kind: 'parse' });
  });

  it('throws network on fetch rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('ECONNREFUSED'); }));
    const p = new TavilyProvider({ apiKey: 'k' });
    await expect(p.search('q')).rejects.toMatchObject({ kind: 'network' });
  });

  it('health() returns true on 200 with results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(VALID_BODY)));
    const p = new TavilyProvider({ apiKey: 'k' });
    expect(await p.health()).toBe(true);
  });

  it('health() returns false on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    const p = new TavilyProvider({ apiKey: 'k' });
    expect(await p.health()).toBe(false);
  });
});
