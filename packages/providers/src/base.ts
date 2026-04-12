import { ProviderError } from './errors.js';
import type { ProviderKind } from './types.js';
import { lookup as dnsLookup } from 'node:dns/promises';

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 15000;

/**
 * Returns true if the hostname in `url` resolves to at least one link-local
 * IPv6 address (fe80::/10) and no reachable IPv4 address. When this is the
 * case, Node's undici-based fetch will hang until the timeout fires because
 * link-local addresses require a scope ID (%eth0 / %en0) that is absent from
 * plain hostnames.
 *
 * We only warn — we don't block — because the lookup adds latency and the
 * IPv4-first dispatcher in bin/pylon.ts already handles the connection level.
 */
async function warnIfLinkLocalOnly(url: string, kind: ProviderKind): Promise<void> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return; // malformed URL — fetchJson will surface the real error
  }
  // Skip bare IPs — they don't go through DNS.
  if (/^[\d.]+$/.test(hostname) || hostname.includes(':')) return;

  try {
    const addresses = await dnsLookup(hostname, { all: true, family: 0 });
    const hasLinkLocal = addresses.some(a => /^fe80:/i.test(a.address));
    const hasRoutable  = addresses.some(a => a.family === 4 || !/^fe80:/i.test(a.address));
    if (hasLinkLocal && !hasRoutable) {
      process.stderr.write(
        `\npylon [${kind}]: WARNING — "${hostname}" resolves only to a link-local IPv6 address ` +
        `(${addresses.find(a => /^fe80:/i.test(a.address))?.address ?? 'fe80::…'}). ` +
        `Connection will likely time out. ` +
        `Try using the IPv4 address directly in the provider base URL.\n\n`,
      );
    }
  } catch {
    // DNS lookup failed — fetchJson will surface the real error.
  }
}

export function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, '');
  const trimmedPath = path.replace(/^\/+/, '');
  return `${trimmedBase}/${trimmedPath}`;
}

export function authHeaders(
  mode: 'none' | 'api-key' | 'bearer',
  apiKey: string | undefined,
  style: 'bearer' | 'x-api-key' = 'bearer',
): Record<string, string> {
  if (mode === 'none' || apiKey === undefined || apiKey === '') return {};
  if (style === 'x-api-key') return { 'x-api-key': apiKey };
  return { Authorization: `Bearer ${apiKey}` };
}

interface RequestOptions {
  kind: ProviderKind;
  url: string;
  headers?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Thin fetch wrapper that translates network and HTTP errors into
 * ProviderError. One retry on UNREACHABLE/SERVER_ERROR with 250ms backoff.
 */
export async function fetchJson<T>(opts: RequestOptions): Promise<T> {
  // Fire-and-forget: warn if the hostname resolves only to link-local IPv6.
  // This does not block the request — the IPv4-first dispatcher in pylon.ts
  // already handles the connection ordering at the undici level.
  void warnIfLinkLocalOnly(opts.url, opts.kind);

  const attempt = async (retriesLeft: number): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => { controller.abort(); },
      opts.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
    );
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => { controller.abort(); });
    }
    try {
      const res = await fetch(opts.url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...(opts.headers ?? {}) },
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError('AUTH_FAILED', opts.kind, `HTTP ${String(res.status)}`);
      }
      if (res.status === 404) {
        throw new ProviderError('NOT_SUPPORTED', opts.kind, `HTTP 404 at ${opts.url}`);
      }
      if (res.status === 429) {
        throw new ProviderError('RATE_LIMITED', opts.kind, 'HTTP 429');
      }
      if (res.status >= 500) {
        if (retriesLeft > 0) {
          await sleep(250);
          return attempt(retriesLeft - 1);
        }
        throw new ProviderError('SERVER_ERROR', opts.kind, `HTTP ${String(res.status)}`);
      }
      if (!res.ok) {
        throw new ProviderError('BAD_RESPONSE', opts.kind, `HTTP ${String(res.status)}`);
      }
      try {
        return (await res.json()) as T;
      } catch (err) {
        throw new ProviderError('BAD_RESPONSE', opts.kind, 'Invalid JSON', err);
      }
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof ProviderError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ProviderError('TIMEOUT', opts.kind, `Request timed out after ${String(opts.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS)}ms`);
      }
      if (retriesLeft > 0) {
        await sleep(250);
        return attempt(retriesLeft - 1);
      }
      throw new ProviderError('UNREACHABLE', opts.kind, err instanceof Error ? err.message : String(err), err);
    } finally {
      clearTimeout(timer);
    }
  };
  return attempt(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
