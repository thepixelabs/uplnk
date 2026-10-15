import { useState, useCallback, useRef } from 'react';
import type { ProviderConfig as PyProviderConfig } from '@uplnk/providers';
import { makeProvider, OllamaProvider } from '@uplnk/providers';

export interface PullState {
  modelId: string;
  /** Last status text from the NDJSON stream, e.g. "pulling manifest". */
  statusText: string;
  /** Bytes downloaded so far (0 if unknown). */
  completed: number;
  /** Total bytes expected (0 if unknown). */
  total: number;
  phase: 'pending' | 'pulling' | 'verifying' | 'done' | 'error';
  errorMsg?: string;
}

export interface UsePullQueueResult {
  pulls: ReadonlyMap<string, PullState>;
  startPull: (modelId: string) => void;
  dismiss: (modelId: string) => void;
}

export function usePullQueue(
  providerConfig: PyProviderConfig | null,
  onPullDone?: () => void,
): UsePullQueueResult {
  const [pulls, setPulls] = useState<Map<string, PullState>>(new Map());
  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  const activeRef      = useRef<Set<string>>(new Set());

  const patch = useCallback((modelId: string, update: Partial<PullState>) => {
    setPulls((prev) => {
      const next = new Map(prev);
      const cur = next.get(modelId) ?? {
        modelId, statusText: '', completed: 0, total: 0, phase: 'pending' as const,
      };
      next.set(modelId, { ...cur, ...update });
      return next;
    });
  }, []);

  const startPull = useCallback((modelId: string) => {
    if (providerConfig === null) return;
    if (activeRef.current.has(modelId)) return;

    const provider = makeProvider(providerConfig);
    if (!(provider instanceof OllamaProvider)) return;

    const controller = new AbortController();
    controllersRef.current.set(modelId, controller);
    activeRef.current.add(modelId);

    patch(modelId, { phase: 'pending', statusText: 'starting…', completed: 0, total: 0 });

    void (async () => {
      try {
        for await (const event of provider.pullModel(modelId, controller.signal)) {
          if (event.error !== undefined && event.error !== '') {
            patch(modelId, { phase: 'error', statusText: 'error', errorMsg: event.error });
            return;
          }
          const phase =
            event.status === 'success' ? 'done' :
            (event.status.startsWith('verif') || event.status.startsWith('writ') || event.status.startsWith('remov'))
              ? 'verifying'
              : 'pulling';
          patch(modelId, {
            phase,
            statusText: event.status,
            completed: event.completed ?? 0,
            total: event.total ?? 0,
          });
          if (event.status === 'success') {
            onPullDone?.();
            break;
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          // Aborted via dismiss — entry already removed.
        } else {
          patch(modelId, {
            phase: 'error',
            statusText: 'error',
            errorMsg: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        controllersRef.current.delete(modelId);
        activeRef.current.delete(modelId);
      }
    })();
  }, [providerConfig, patch, onPullDone]);

  const dismiss = useCallback((modelId: string) => {
    controllersRef.current.get(modelId)?.abort();
    controllersRef.current.delete(modelId);
    activeRef.current.delete(modelId);
    setPulls((prev) => {
      const next = new Map(prev);
      next.delete(modelId);
      return next;
    });
  }, []);

  return { pulls, startPull, dismiss };
}
