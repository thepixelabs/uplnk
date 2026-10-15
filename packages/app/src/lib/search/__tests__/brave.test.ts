/**
 * brave.ts — unit tests for BraveProvider.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BraveProvider } from '../brave.js';
import { SearchError } from '../types.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const VALID_BODY = {
  web: {
    results: [
      {
        url: 'https://example.com/a',
        title: 'A',
        description: 'first hit',
        age: '2 hours ago',
      },
      { url: 'https://example.com/b', title: 'B', description: 'second' },
    ],
  },
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BraveProvider', () => {
  it('constructor rejects empty apiKey', () => {
    expect(() => new BraveProvider({ apiKey: '' })).toThrow(SearchError);
  });

  it('maps response to SearchResult[]', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(VALID_BODY)));
    const p = new BraveProvider({ apiKey: 'k' });
    const out = await p.search('hello');
    expect(out).toHaveLength(2);
    expect(out[0]!.url).toBe('https://example.com/a');
    expect(out[0]!.snippet).toBe('first hit');
    expect(out[0]!.publishedAt).toBe('2 hours ago');
    expect(out[0]!.source).toBe('brave');
    expect(out[1]!.publishedAt).toBeUndefined();
  });

  it('sends X-Subscription-Token header and freshness for timeRange', async () => {
    const fetchSpy = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => jsonResponse(VALID_BODY),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const p = new BraveProvider({ apiKey: 'kk' });
    await p.search('q', { count: 7, timeRange: 'month' });
    const call = fetchSpy.mock.calls[0]!;
    const urlStr = call[0];
    expect(urlStr.startsWith('https://api.search.brave.com/res/v1/web/search?')).toBe(true);
    const u = new URL(urlStr);
    expect(u.searchParams.get('q')).toBe('q');
    expect(u.searchParams.get('count')).toBe('7');
    expect(u.searchParams.get('freshness')).toBe('pm');
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Subscription-Token']).toBe('kk');
  });

  it('throws no-results when web.results is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ web: { results: [] } })));
    const p = new BraveProvider({ apiKey: 'k' });
    await expect(p.search('q')).rejects.toMatchObject({ kind: 'no-results', provider: 'brave' });
  });

  it('throws auth on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    const p = new BraveProvider({ apiKey: 'k' });
    await expect(p.search('q')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('throws auth on 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    const p = new BraveProvider({ apiKey: 'k' });
    await expect(p.search('q')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('throws rate-limit on 429', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })));
    const p = new BraveProvider({ apiKey: 'k' });
    await expect(p.search('q')).rejects.toMatchObject({ kind: 'rate-limit' });
  });

  it('throws timeout on external abort', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }));
    const p = new BraveProvider({ apiKey: 'k' });
    const ctrl = new AbortController();
    const pending = p.search('q', { signal: ctrl.signal, timeoutMs: 5000 });
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('throws parse on bad JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('garbage', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ));
    const p = new BraveProvider({ apiKey: 'k' });
    await expect(p.search('q')).rejects.toMatchObject({ kind: 'parse' });
  });

  it('throws parse when web.results is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ web: {} })));
    const p = new BraveProvider({ apiKey: 'k' });
    await expect(p.search('q')).rejects.toMatchObject({ kind: 'parse' });
  });

  it('health() returns true on a valid response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(VALID_BODY)));
    const p = new BraveProvider({ apiKey: 'k' });
    expect(await p.health()).toBe(true);
  });

  it('health() returns false on auth failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    const p = new BraveProvider({ apiKey: 'k' });
    expect(await p.health()).toBe(false);
  });
});
