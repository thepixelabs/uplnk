import { useEffect, useState } from 'react';
import { makeProvider } from '@uplnk/providers';
import type { AuthMode, ProviderKind } from '@uplnk/providers';
import {
  PROVIDER_CONNECTIVITY_POLL_MS,
  PROVIDER_CONNECTIVITY_TIMEOUT_MS,
  getProviderHost,
} from '../lib/providerConnectivity.js';

export interface ProviderConnectivityState {
  host: string;
  connected: boolean;
  checkedAt: number | null;
  latencyMs: number | null;
  disconnectedSince: number | null;
  errorDetail: string | null;
  /**
   * Lowercased ids of models the server is currently serving. Populated on the
   * same probe as `connected` — the connectivity check fetches `/api/tags` (or
   * the provider equivalent) and we cache the list so the chat screen can warn
   * the user when the resolved model isn't actually installed there.
   *
   * `null` means "not yet probed". An empty Set means "probe succeeded but the
   * server reported no models" — semantically different from null and treated
   * as "model unavailable" by the chat-screen check.
   */
  installedModelIds: ReadonlySet<string> | null;
}

interface UseProviderConnectivityInput {
  providerType: string;
  baseURL: string;
  apiKey: string;
  authMode: AuthMode;
}

export function useProviderConnectivity({
  providerType,
  baseURL,
  apiKey,
  authMode,
}: UseProviderConnectivityInput): ProviderConnectivityState {
  const [state, setState] = useState<ProviderConnectivityState>(() => ({
    host: getProviderHost(baseURL),
    connected: false,
    checkedAt: null,
    latencyMs: null,
    disconnectedSince: null,
    errorDetail: null,
    installedModelIds: null,
  }));

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let activeController: AbortController | null = null;

    const host = getProviderHost(baseURL);

    const scheduleNextCheck = () => {
      if (disposed) return;
      timer = setTimeout(() => {
        void runCheck();
      }, PROVIDER_CONNECTIVITY_POLL_MS);
    };

    const runCheck = async () => {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;

      try {
        const provider = makeProvider({
          id: '__header_provider_health__',
          name: 'Header Provider Health',
          kind: providerType as ProviderKind,
          baseUrl: baseURL,
          authMode,
          ...(apiKey.trim() !== '' ? { apiKey } : {}),
          discoveryTimeoutMs: PROVIDER_CONNECTIVITY_TIMEOUT_MS,
        });
        // Probe via listModels rather than testConnection: on Ollama these are
        // the same HTTP call, and we want the model list anyway so the chat
        // screen can warn when the configured model isn't installed.
        const started = Date.now();
        const models = await provider.listModels(controller.signal);
        const latencyMs = Date.now() - started;
        if (disposed) return;
        const checkedAt = Date.now();
        const modelIds: ReadonlySet<string> = new Set(
          models.map((m) => m.id.toLowerCase()),
        );
        setState((prev) => {
          // Skip update if already connected, latency bucket unchanged, and the
          // model set is unchanged — avoids re-renders on every 15 s tick.
          const prevBucket = prev.latencyMs !== null ? Math.floor(prev.latencyMs / 100) : -1;
          const nextBucket = Math.floor(latencyMs / 100);
          const sameModels =
            prev.installedModelIds !== null &&
            prev.installedModelIds.size === modelIds.size &&
            Array.from(modelIds).every((id) => prev.installedModelIds!.has(id));
          if (prev.connected && prev.host === host && prevBucket === nextBucket && sameModels) {
            return prev;
          }
          return {
            host,
            connected: true,
            checkedAt,
            latencyMs,
            disconnectedSince: null,
            errorDetail: null,
            installedModelIds: modelIds,
          };
        });
      } catch (err) {
        if (disposed) return;
        const checkedAt = Date.now();
        setState((prev) => ({
          host,
          connected: false,
          checkedAt,
          latencyMs: null,
          disconnectedSince: prev.host === host ? (prev.disconnectedSince ?? checkedAt) : checkedAt,
          errorDetail: err instanceof Error ? err.message : String(err),
          // Preserve the last-known model list across transient probe failures
          // so the warning doesn't flicker on every network hiccup.
          installedModelIds: prev.host === host ? prev.installedModelIds : null,
        }));
      } finally {
        scheduleNextCheck();
      }
    };

    setState({
      host,
      connected: false,
      checkedAt: null,
      latencyMs: null,
      disconnectedSince: null,
      errorDetail: null,
      installedModelIds: null,
    });
    void runCheck();

    return () => {
      disposed = true;
      activeController?.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [providerType, baseURL, apiKey, authMode]);

  return state;
}
