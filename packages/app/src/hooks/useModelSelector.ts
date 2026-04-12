import { useState, useEffect, useCallback } from 'react';

interface OllamaModel {
  name: string;
}

interface OllamaTagsResponse {
  models: OllamaModel[];
}

export interface UseModelSelectorResult {
  models: string[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useModelSelector(baseUrl = 'http://localhost:11434'): UseModelSelectorResult {
  const [models, setModels] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchModels = useCallback(() => {
    setIsLoading(true);
    setError(null);

    fetch(`${baseUrl}/api/tags`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status.toString()}`);
        return res.json() as Promise<OllamaTagsResponse>;
      })
      .then((data) => {
        setModels(data.models.map((m) => m.name));
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to fetch models');
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [baseUrl]);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  return { models, isLoading, error, refresh: fetchModels };
}
