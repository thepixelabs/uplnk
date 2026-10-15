/**
 * duckduckgo.ts — unit tests for DuckDuckGoProvider.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DuckDuckGoProvider, __resetDdgWarningsForTests } from '../duckduckgo.js';

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html' },
  });
}

const VALID_HTML = `
  <html><body>
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=abc">
        <b>Example</b> A
      </a>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=...">First &amp; foremost snippet</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://example.com/b">Example B</a>
      <a class="result__snippet">Second snippet</a>
    </div>
  </body></html>
`;

beforeEach(() => {
  vi.restoreAllMocks();
  __resetDdgWarningsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DuckDuckGoProvider', () => {
  it('parses a happy-path HTML response and unwraps the DDG redirect', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(VALID_HTML)));
    const p = new DuckDuckGoProvider();
    const out = await p.search('hello');
    expect(out).toHaveLength(2);
    expect(out[0]!.url).toBe('https://example.com/a');
    expect(out[0]!.title).toBe('Example A');
    expect(out[0]!.snippet).toBe('First & foremost snippet');
    expect(out[0]!.source).toBe('duckduckgo');
    expect(out[1]!.url).toBe('https://example.com/b');
    expect(out[1]!.title).toBe('Example B');
    expect(out[1]!.snippet).toBe('Second snippet');
  });

  it('honours the count cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(VALID_HTML)));
    const p = new DuckDuckGoProvider();
    const out = await p.search('hello', { count: 1 });
    expect(out).toHaveLength(1);
  });

  it('warns once for unsupported options', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(VALID_HTML)));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const p = new DuckDuckGoProvider();
    await p.search('q', { timeRange: 'week', includeDomains: ['x'], excludeDomains: ['y'] });
    await p.search('q', { timeRange: 'week' }); // should not warn again
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain('timeRange');
    expect(warnSpy.mock.calls[0]![0]).toContain('includeDomains');
    expect(warnSpy.mock.calls[0]![0]).toContain('excludeDomains');
  });

  it('throws no-results when HTML contains zero result blocks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse('<html>no results</html>')));
    const p = new DuckDuckGoProvider();
    await expect(p.search('q')).rejects.toMatchObject({ kind: 'no-results', provider: 'duckduckgo' });
  });

  it('throws rate-limit on 403 (DDG blocks scrapers via 403)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    const p = new DuckDuckGoProvider();
    await expect(p.search('q')).rejects.toMatchObject({ kind: 'rate-limit' });
  });

  it('throws rate-limit on 429', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })));
    const p = new DuckDuckGoProvider();
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
    const p = new DuckDuckGoProvider();
    const ctrl = new AbortController();
    const pending = p.search('q', { signal: ctrl.signal, timeoutMs: 5000 });
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('throws network on fetch rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('ECONNREFUSED'); }));
    const p = new DuckDuckGoProvider();
    await expect(p.search('q')).rejects.toMatchObject({ kind: 'network' });
  });

  it('throws parse on empty body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    const p = new DuckDuckGoProvider();
    await expect(p.search('q')).rejects.toMatchObject({ kind: 'parse' });
  });

  it('skips result blocks whose href does not unwrap to http(s)', async () => {
    const html = `
      <a class="result__a" href="javascript:void(0)">bad</a>
      <a class="result__snippet">bad snippet</a>
      <a class="result__a" href="https://good.com/x">good</a>
      <a class="result__snippet">good snippet</a>
    `;
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(html)));
    const p = new DuckDuckGoProvider();
    const out = await p.search('q');
    expect(out).toHaveLength(1);
    expect(out[0]!.url).toBe('https://good.com/x');
  });

  it('health() returns true on parseable HTML with results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(VALID_HTML)));
    const p = new DuckDuckGoProvider();
    expect(await p.health()).toBe(true);
  });

  it('health() returns false when blocked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    const p = new DuckDuckGoProvider();
    expect(await p.health()).toBe(false);
  });
});
