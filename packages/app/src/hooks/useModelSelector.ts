import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Model, ProviderConfig as PyProviderConfig } from 'uplnk-providers';
import { makeProvider, mergeWithCatalog, ProviderError } from 'uplnk-providers';
import { loadCatalog } from 'uplnk-catalog';

export interface UseModelSelectorResult {
  installed: Model[];
  available: Model[];
  isLoading: boolean;
  /** `null` when the fetch succeeded. */
  error: string | null;
  /** Friendly error code for conditional UI (badge color etc.) */
  errorCode: string | null;
  refresh: () => void;
}

/**
 * Discover models for a provider and merge them with the static catalog.
 *
 * Returns two lists: `installed` (models the server actually serves, enriched
 * with catalog metadata where matches exist) and `available` (catalog-only
 * entries for this provider kind that the server doesn't currently serve).
 */
export function useModelSelector(
  providerConfig: PyProviderConfig | null,
): UseModelSelectorResult {
  const [installed, setInstalled] = useState<Model[]>([]);
  const [available, setAvailable] = useState<Model[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const catalog = useMemo(() => loadCatalog(), []);

  const refresh = useCallback(() => { setRefreshKey((k) => k + 1); }, []);

  useEffect(() => {
    if (providerConfig === null) {
      setInstalled([]);
      setAvailable([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    setErrorCode(null);
    const controller = new AbortController();
    const provider = makeProvider(providerConfig);
    provider.listModels(controller.signal)
      .then((discovered) => {
        const merged = mergeWithCatalog(provider.kind, discovered, catalog);
        setInstalled(merged.installed);
        setAvailable(merged.available);
      })
      .catch((err: unknown) => {
        const merged = mergeWithCatalog(provider.kind, [], catalog);
        setInstalled([]);
        setAvailable(merged.available);
        if (err instanceof ProviderError) {
          setError(err.userMessage);
          setErrorCode(err.code);
        } else {
          setError(err instanceof Error ? err.message : 'Failed to fetch models');
          setErrorCode('UNKNOWN');
        }
      })
      .finally(() => { setIsLoading(false); });
    return () => { controller.abort(); };
  }, [providerConfig, catalog, refreshKey]);

  return { installed, available, isLoading, error, errorCode, refresh };
}
