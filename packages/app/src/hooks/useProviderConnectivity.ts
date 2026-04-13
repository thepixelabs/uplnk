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
        const health = await provider.testConnection(controller.signal);
        if (disposed) return;
        setState({
          host,
          connected: true,
          checkedAt: health.checkedAt,
          latencyMs: health.latencyMs,
          disconnectedSince: null,
          errorDetail: null,
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
