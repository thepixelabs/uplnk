/**
 * DuckDuckGoProvider — keyless escape hatch via the unofficial HTML endpoint.
 *
 * No API key required. Hits https://html.duckduckgo.com/html/ and parses the
 * HTML response with a minimal regex extractor (no cheerio dep).
 *
 * Endpoint: GET https://html.duckduckgo.com/html/?q=<query>
 *   200 with HTML body. Result blocks look approximately like:
 *     <a class="result__a" href="//duckduckgo.com/l/?uddg=<encoded-url>&...">
 *       Title text
 *     </a>
 *     <a class="result__snippet" ...>Snippet text</a>
 *
 * WARNING: this HTML shape is unstable. DDG changes class names, redirect
 * wrapping, and entity escaping without notice. This provider is intentionally
 * "best effort" — it exists so users can try the deep-research feature
 * without signing up for Tavily or Brave first. It is NOT recommended for
 * production research workloads. If you care about correctness, configure
 * Tavily or Brave as your default and let DDG be the fallback.
 *
 * Unsupported options (logged once, then silently ignored):
 *   - timeRange       — no equivalent in the HTML endpoint
 *   - includeDomains  — no equivalent in the HTML endpoint
 *   - excludeDomains  — no equivalent in the HTML endpoint
 */

import {
  DEFAULT_SEARCH_COUNT,
  DEFAULT_SEARCH_TIMEOUT_MS,
  SearchError,
  type SearchOptions,
  type SearchProvider,
  type SearchResult,
} from './types.js';

const ENDPOINT = 'https://html.duckduckgo.com/html/';
const PROVIDER_NAME = 'duckduckgo';

/**
 * One result block from the DDG HTML page.
 *
 * The regex set:
 *   1. RESULT_BLOCK_RE  — locate every `<a class="result__a" href="...">title</a>`.
 *      The capture group order is [_, href, innerHtml].
 *   2. SNIPPET_RE       — locate `<a class="result__snippet" ...>snippet</a>` OR
 *      a sibling `<a class="result__snippet" ...>...</a>`. We sweep the WHOLE
 *      page once with a global regex then zip results to titles by index.
 *
 * Decoding rules applied to every captured string:
 *   - strip HTML tags (`<b>highlight</b>` etc.) via `<[^>]+>` → ''
 *   - decode the common entities: &amp; &quot; &#39; &lt; &gt; &nbsp;
 *   - the DDG URL is wrapped — unwrap if it matches `//duckduckgo.com/l/?uddg=<encoded>`.
 */
const RESULT_BLOCK_RE = /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
const SNIPPET_BLOCK_RE = /<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function cleanText(raw: string): string {
  return decodeEntities(stripHtml(raw)).replace(/\s+/g, ' ').trim();
}

function unwrapDdgRedirect(href: string): string | null {
  // DDG wraps real URLs like //duckduckgo.com/l/?uddg=<encoded>&rut=...
  // The `uddg` param contains the destination, URI-encoded.
  // Either a protocol-relative or absolute form is possible.
  const m = href.match(/[?&]uddg=([^&]+)/i);
  if (m && m[1]) {
    try {
      const decoded = decodeURIComponent(m[1]);
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch {
      // fall through
    }
  }
  // Some result rows link directly. Accept absolute http(s) hrefs.
  if (/^https?:\/\//i.test(href)) return href;
  // Protocol-relative — prepend https.
  if (href.startsWith('//')) {
    // Don't accept DDG-internal redirects we failed to unwrap.
    if (/^\/\/duckduckgo\.com\//i.test(href)) return null;
    return `https:${href}`;
  }
  return null;
}

function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
  const titles: Array<{ url: string; title: string }> = [];
  for (const m of html.matchAll(RESULT_BLOCK_RE)) {
    if (titles.length >= limit) break;
    const href = m[1];
    const inner = m[2];
    if (href === undefined || inner === undefined) continue;
    const url = unwrapDdgRedirect(decodeEntities(href));
    if (url === null) continue;
    const title = cleanText(inner);
    if (title === '') continue;
    titles.push({ url, title });
  }

  const snippets: string[] = [];
  for (const m of html.matchAll(SNIPPET_BLOCK_RE)) {
    if (m[1] === undefined) continue;
    snippets.push(cleanText(m[1]));
  }

  const out: SearchResult[] = [];
  for (let i = 0; i < titles.length; i++) {
    const entry = titles[i]!;
    out.push({
      url: entry.url,
      title: entry.title,
      snippet: snippets[i] ?? '',
      source: 'duckduckgo',
    });
  }
  return out;
}

let unsupportedOptsWarned = false;
function warnUnsupportedOpts(opts: SearchOptions): void {
  if (unsupportedOptsWarned) return;
  const hits: string[] = [];
  if (opts.timeRange !== undefined) hits.push('timeRange');
  if (opts.includeDomains && opts.includeDomains.length > 0) hits.push('includeDomains');
  if (opts.excludeDomains && opts.excludeDomains.length > 0) hits.push('excludeDomains');
  if (hits.length === 0) return;
  unsupportedOptsWarned = true;
  console.warn(
    `[DuckDuckGoProvider] ignoring unsupported option(s): ${hits.join(', ')} — ` +
    `the HTML endpoint does not expose these filters`,
  );
}

/** Test-only — reset the one-shot warning flag. */
export function __resetDdgWarningsForTests(): void {
  unsupportedOptsWarned = false;
}

export interface DuckDuckGoProviderOptions {
  baseUrl?: string;
}

export class DuckDuckGoProvider implements SearchProvider {
  readonly name = PROVIDER_NAME;
  private readonly endpoint: string;

  constructor(opts: DuckDuckGoProviderOptions = {}) {
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
    warnUnsupportedOpts(opts);

    const timeoutMs = opts.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
    const count = opts.count ?? DEFAULT_SEARCH_COUNT;
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
    const onExternalAbort = (): void => { controller.abort(); };
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const params = new URLSearchParams({ q: query });
    const url = `${this.endpoint}?${params.toString()}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          // DDG HTML endpoint is sensitive to bot UAs; pretend to be a browser.
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new SearchError('timeout', `DDG request timed out after ${String(timeoutMs)}ms`, PROVIDER_NAME, err);
      }
      throw new SearchError('network', err instanceof Error ? err.message : String(err), PROVIDER_NAME, err);
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort);
    }

    // DDG sometimes 403s scrapers; we route that to rate-limit because it
    // means "try again later / try a different provider" rather than "fix
    // your credentials" — DDG has no credentials to fix.
    if (res.status === 403 || res.status === 429) {
      throw new SearchError('rate-limit', `DDG blocked (HTTP ${String(res.status)})`, PROVIDER_NAME);
    }
    if (!res.ok) {
      throw new SearchError('unknown', `DDG HTTP ${String(res.status)}`, PROVIDER_NAME);
    }

    let html: string;
    try {
      html = await res.text();
    } catch (err) {
      throw new SearchError('parse', 'DDG response body unreadable', PROVIDER_NAME, err);
    }

    if (typeof html !== 'string' || html.length === 0) {
      throw new SearchError('parse', 'DDG response body was empty', PROVIDER_NAME);
    }

    const results = parseDuckDuckGoHtml(html, count);
    if (results.length === 0) {
      throw new SearchError('no-results', `DDG returned 0 parseable results for "${query}"`, PROVIDER_NAME);
    }
    return results;
  }
}
