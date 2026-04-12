import { useState, useCallback, useRef, useEffect } from 'react';
import type { DiscoveredServer, ScanResult } from '../lib/networkScanner.js';
import { scanNetwork, getLocalSubnetHosts } from '../lib/networkScanner.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ScanStatus = 'idle' | 'scanning' | 'done' | 'cancelled' | 'error';

export interface UseNetworkScanResult {
  servers: DiscoveredServer[];
  status: ScanStatus;
  /** Number of hosts probed so far (set once scan completes). */
  hostsProbed: number;
  /** Total hosts to probe (set when scan starts). */
  totalHosts: number;
  errorMessage: string | null;
  /**
   * Start a network scan.
   *
   * @param scope         - 'localhost' (default) or 'subnet'.
   * @param subnetConfirmedAt - Required when scope='subnet'. Must be the ISO
   *   timestamp from config.networkScanner.subnetConfirmedAt. Passed through
   *   to scanNetwork() which enforces the consent gate.
   */
  startScan: (scope?: 'localhost' | 'subnet', subnetConfirmedAt?: string) => void;
  cancelScan: () => void;
  reset: () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Flush cadence for buffered scan results → React state.
 * 200ms (5Hz) is more than adequate for a network scan where probes
 * arrive at most every few hundred milliseconds — no need to hammer
 * the React reconciler the way a token stream would.
 */
const FLUSH_INTERVAL_MS = 200;

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * React hook that drives a local network scan for AI inference servers.
 *
 * Results stream into `servers` as probes complete. The flush timer ensures
 * React re-renders happen at most 5Hz so the TUI stays responsive during a
 * subnet sweep (up to 512 hosts × 6 probes = 3072 fetch calls).
 *
 * Usage:
 *   const { servers, status, startScan, cancelScan } = useNetworkScan();
 *   startScan('localhost');   // or 'subnet'
 */
export function useNetworkScan(): UseNetworkScanResult {
  const [servers, setServers] = useState<DiscoveredServer[]>([]);
  const [status, setStatus] = useState<ScanStatus>('idle');
  const [hostsProbed, setHostsProbed] = useState(0);
  const [totalHosts, setTotalHosts] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // AbortController for the in-flight scan
  const abortControllerRef = useRef<AbortController | null>(null);

  // Buffer for servers discovered between flush ticks — avoids a setState
  // call on every individual probe result during a busy subnet scan.
  const serverBufferRef = useRef<DiscoveredServer[]>([]);

  // Interval handle for the React state flush
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopFlushTimer = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  /**
   * Flush any buffered servers from the probe callbacks into React state.
   * Called both by the interval timer and synchronously on completion/cancel.
   */
  const flushBuffer = useCallback(() => {
    if (serverBufferRef.current.length === 0) return;
    const batch = serverBufferRef.current.splice(0);
    setServers((prev) => [...prev, ...batch]);
  }, []);

  const startScan = useCallback(
    (scope: 'localhost' | 'subnet' = 'localhost', subnetConfirmedAt?: string) => {
      // Cancel any previous scan
      abortControllerRef.current?.abort();
      stopFlushTimer();

      // Reset state for fresh scan
      serverBufferRef.current = [];
      setServers([]);
      setHostsProbed(0);
      setErrorMessage(null);
      setStatus('scanning');

      const controller = new AbortController();
      abortControllerRef.current = controller;

      // Derive totalHosts from the same host enumeration the scanner uses
      // so the UI can show a progress denominator immediately.
      setTotalHosts(getLocalSubnetHosts(scope).length);

      // Start the flush timer — at most 5 React re-renders per second
      flushTimerRef.current = setInterval(flushBuffer, FLUSH_INTERVAL_MS);

      scanNetwork({
        scope,
        signal: controller.signal,
        ...(subnetConfirmedAt !== undefined ? { subnetConfirmedAt } : {}),
        onResult: (server) => {
          // Accumulate in the ref; the interval timer will flush to state
          serverBufferRef.current.push(server);
        },
      })
        .then((result: ScanResult) => {
          stopFlushTimer();
          // Final synchronous flush so no discoveries are lost
          flushBuffer();
          setHostsProbed(result.hostsProbed);

          if (controller.signal.aborted) {
            setStatus('cancelled');
          } else {
            setStatus('done');
          }
        })
        .catch((err: unknown) => {
          stopFlushTimer();
          flushBuffer();

          if (
            err instanceof Error &&
            (err.name === 'AbortError' || controller.signal.aborted)
          ) {
            setStatus('cancelled');
            return;
          }

          setErrorMessage(err instanceof Error ? err.message : String(err));
          setStatus('error');
        });
    },
    [flushBuffer, stopFlushTimer],
  );

  const cancelScan = useCallback(() => {
    abortControllerRef.current?.abort();
    stopFlushTimer();
    flushBuffer();
    setStatus('cancelled');
  }, [flushBuffer, stopFlushTimer]);

  const reset = useCallback(() => {
    abortControllerRef.current?.abort();
    stopFlushTimer();
    serverBufferRef.current = [];
    setServers([]);
    setStatus('idle');
    setHostsProbed(0);
    setTotalHosts(0);
    setErrorMessage(null);
  }, [stopFlushTimer]);

  // Clean up on unmount: abort any live scan and stop the flush timer so
  // we don't schedule setState calls on an unmounted component.
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      if (flushTimerRef.current !== null) {
        clearInterval(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, []);

  return {
    servers,
    status,
    hostsProbed,
    totalHosts,
    errorMessage,
    startScan,
    cancelScan,
    reset,
  };
}
