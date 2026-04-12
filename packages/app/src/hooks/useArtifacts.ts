/**
 * useArtifacts — manages the artifact panel state.
 *
 * An artifact is "promoted" when:
 *   - A code block has >= PROMOTE_THRESHOLD lines, OR
 *   - The user explicitly selects a code block (future keyboard nav)
 *
 * The hook exposes the active artifact (if any) and a function to promote/
 * dismiss it. ChatScreen calls this and conditionally renders ArtifactPanel.
 */

import { useState, useCallback } from 'react';
import type { Artifact } from '../components/artifacts/ArtifactPanel.js';

/** Code blocks with >= this many lines auto-promote to artifact panel */
export const PROMOTE_THRESHOLD = 15;

export interface UseArtifactsResult {
  activeArtifact: Artifact | null;
  promoteArtifact: (artifact: Artifact) => void;
  dismissArtifact: () => void;
  updateArtifact: (id: string, updates: Partial<Pick<Artifact, 'code'>>) => void;
}

export function useArtifacts(): UseArtifactsResult {
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null);

  const promoteArtifact = useCallback((artifact: Artifact) => {
    setActiveArtifact(artifact);
  }, []);

  const dismissArtifact = useCallback(() => {
    setActiveArtifact(null);
  }, []);

  const updateArtifact = useCallback((id: string, updates: Partial<Pick<Artifact, 'code'>>) => {
    setActiveArtifact((prev) => {
      if (prev === null || prev.id !== id) return prev;
      return { ...prev, ...updates };
    });
  }, []);

  return { activeArtifact, promoteArtifact, dismissArtifact, updateArtifact };
}
