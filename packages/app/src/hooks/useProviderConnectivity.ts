import { useEffect, useRef, useState } from 'react';
import { makeProvider } from '@uplnk/providers';
import type { AuthMode, ProviderKind } from '@uplnk/providers';
import {
  PROVIDER_CONNECTIVITY_POLL_MS,
  PROVIDER_CONNECTIVITY_TIMEOUT_MS,
  getProviderHost,
  nextConnectivityState,
  type ConnectivityFsmPrev,
} from '../lib/providerConnectivity.js';
import { launchOllama, type OllamaLaunchOutcome } from '../lib/ollamaLifecycle.js';

/** Minimum gap between auto-launch attempts. We never spawn `ollama serve`
 * twice in this window — even across degraded→cooldown re-entries. */
export const OLLAMA_AUTOLAUNCH_DEBOUNCE_MS = 60_000;

export type OllamaInstallStatus = 'unknown' | 'present' | 'missing';

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
  /** True while a launch is in-flight; resets when the outcome resolves. */
  autoLaunchInFlight: boolean;
  /** Most recent {@link OllamaLaunchOutcome}, or null if no attempt yet. */
  lastLaunchOutcome: OllamaLaunchOutcome | null;
  /** Tri-state install signal derived from launch outcomes. */
  ollamaInstalled: OllamaInstallStatus;
}

interface UseProviderConnectivityInput {
  providerType: string;
  baseURL: string;
  apiKey: string;
  authMode: AuthMode;
  /** When true, attempt `ollama serve` on the first probe failure. Default false. */
  autoLaunchOllama?: boolean;
}

/**
 * The active provider is "ollama-like" when the kind says so AND the URL
 * targets the default daemon port — we don't try to spawn a daemon for a
 * remote Ollama install or a tunneled instance.
 */
function isLocalOllamaTarget(providerType: string, baseURL: string): boolean {
  if (providerType !== 'ollama') return false;
  try {
    const u = new URL(baseURL);
    if (u.port !== '11434') return false;
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
  } catch {
    return false;
  }
}

export function useProviderConnectivity({
  providerType,
  baseURL,
  apiKey,
  authMode,
  autoLaunchOllama = false,
}: UseProviderConnectivityInput): ProviderConnectivityState {
  const [state, setState] = useState<ProviderConnectivityState>(() => ({
    host: getProviderHost(baseURL),
    connected: false,
    checkedAt: null,
    latencyMs: null,
    disconnectedSince: null,
    errorDetail: null,
    installedModelIds: null,
    autoLaunchInFlight: false,
    lastLaunchOutcome: null,
    ollamaInstalled: 'unknown',
  }));

  // FSM tracking — kept in a ref so transitions don't trigger re-renders on
  // their own. The hook still re-renders when the publicly-visible state above
  // changes shape (connected flip, latency bucket, error, model list).
  const fsmRef = useRef<ConnectivityFsmPrev>({
    fsmState: 'healthy',
    consecutiveFailures: 0,
    disconnectedSince: null,
  });

  // Debounce key: last wall-clock time we kicked off `launchOllama`. We compare
  // against `Date.now()` rather than using a timer because the user can
  // suspend/resume the laptop between probes and we want real-time semantics.
  const lastLaunchAtRef = useRef<number>(0);
  // Tracks whether we've ever seen a healthy probe in this hook instance — the
  // spec says we only auto-launch on a healthy→degraded edge, not on a hook
  // that came up against a daemon that was never running in the first place.
  const hadHealthyRef = useRef<boolean>(false);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let activeController: AbortController | null = null;
    let launchController: AbortController | null = null;

    const host = getProviderHost(baseURL);
    const isOllamaTarget = isLocalOllamaTarget(providerType, baseURL);

    // Reset FSM + debounce/seen-healthy state whenever the connection identity
    // changes — switching providers must reset everything.
    fsmRef.current = {
      fsmState: 'healthy',
      consecutiveFailures: 0,
      disconnectedSince: null,
    };
    lastLaunchAtRef.current = 0;
    hadHealthyRef.current = false;

    const scheduleNextCheck = (delayMs: number) => {
      if (disposed) return;
      timer = setTimeout(() => {
        void runCheck();
      }, delayMs);
    };

    /** Forces the next probe to fire immediately rather than waiting for the
     * scheduled FSM cadence. Used after a successful auto-launch. */
    const accelerateNextProbe = (): void => {
      if (disposed) return;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      timer = setTimeout(() => {
        void runCheck();
      }, 0);
    };

    const maybeAutoLaunch = (): void => {
      if (!autoLaunchOllama) return;
      if (!isOllamaTarget) return;
      if (!hadHealthyRef.current) return; // healthy→degraded edge only
      if (fsmRef.current.fsmState !== 'degraded') return; // not during cooldown
      const now = Date.now();
      if (now - lastLaunchAtRef.current < OLLAMA_AUTOLAUNCH_DEBOUNCE_MS) return;
      lastLaunchAtRef.current = now;

      setState((prev) => ({ ...prev, autoLaunchInFlight: true }));
      launchController?.abort();
      const controller = new AbortController();
      launchController = controller;

      void (async () => {
        let outcome: OllamaLaunchOutcome;
        try {
          outcome = await launchOllama({ url: baseURL, signal: controller.signal });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          outcome = { status: 'launch-failed', error: message };
        }
        if (disposed) return;

        const installNext: OllamaInstallStatus =
          outcome.status === 'not-installed' ? 'missing' : 'present';

        setState((prev) => ({
          ...prev,
          autoLaunchInFlight: false,
          lastLaunchOutcome: outcome,
          ollamaInstalled: installNext,
        }));

        // Re-probe right away on a successful launch — there's no point
        // waiting out the FSM cooldown if the daemon is now up.
        if (outcome.status === 'started' || outcome.status === 'already-running') {
          accelerateNextProbe();
        }
      })();
    };

    const runCheck = async () => {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;

      let nextPollMs = PROVIDER_CONNECTIVITY_POLL_MS;
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

        const fsmNext = nextConnectivityState(fsmRef.current, {
          kind: 'success',
          now: checkedAt,
        });
        fsmRef.current = {
          fsmState: fsmNext.fsmState,
          consecutiveFailures: fsmNext.consecutiveFailures,
          disconnectedSince: fsmNext.disconnectedSince,
        };
        nextPollMs = fsmNext.nextPollMs;
        hadHealthyRef.current = true;

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
            ...prev,
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

        const fsmNext = nextConnectivityState(fsmRef.current, {
          kind: 'failure',
          now: checkedAt,
        });
        fsmRef.current = {
          fsmState: fsmNext.fsmState,
          consecutiveFailures: fsmNext.consecutiveFailures,
          disconnectedSince: fsmNext.disconnectedSince,
        };
        nextPollMs = fsmNext.nextPollMs;

        const errorDetail = err instanceof Error ? err.message : String(err);
        setState((prev) => ({
          ...prev,
          host,
          connected: false,
          checkedAt,
          latencyMs: null,
          disconnectedSince:
            prev.host === host
              ? (prev.disconnectedSince ?? fsmNext.disconnectedSince ?? checkedAt)
              : (fsmNext.disconnectedSince ?? checkedAt),
          errorDetail,
          // Preserve the last-known model list across transient probe failures
          // so the warning doesn't flicker on every network hiccup.
          installedModelIds: prev.host === host ? prev.installedModelIds : null,
        }));

        // Fire-and-forget — does its own internal gating.
        maybeAutoLaunch();
      } finally {
        scheduleNextCheck(nextPollMs);
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
      autoLaunchInFlight: false,
      lastLaunchOutcome: null,
      ollamaInstalled: 'unknown',
    });
    void runCheck();

    return () => {
      disposed = true;
      activeController?.abort();
      launchController?.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [providerType, baseURL, apiKey, authMode, autoLaunchOllama]);

  return state;
}
