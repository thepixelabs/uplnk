/**
 * useSplitPane — manages split-pane width state for the artifact panel.
 *
 * Width is expressed as a percentage of terminal columns.
 * Default: 50% each side.
 * Min: 30% (artifact panel) / 70% (chat)
 * Max: 70% (artifact panel) / 30% (chat)
 *
 * Keyboard:
 *   [ or < — shrink artifact panel (give more space to chat)
 *   ] or > — grow artifact panel
 *   Ctrl+A  — toggle artifact panel visibility (handled in ChatScreen)
 */

import { useState, useCallback } from 'react';

const MIN_ARTIFACT_PCT = 30;
const MAX_ARTIFACT_PCT = 70;
const DEFAULT_ARTIFACT_PCT = 50;
const STEP = 5;

export interface UseSplitPaneResult {
  artifactWidthPct: number;
  chatWidthPct: number;
  growArtifact: () => void;
  shrinkArtifact: () => void;
  resetWidth: () => void;
}

export function useSplitPane(): UseSplitPaneResult {
  const [artifactWidthPct, setArtifactWidthPct] = useState(DEFAULT_ARTIFACT_PCT);

  const growArtifact = useCallback(() => {
    setArtifactWidthPct((w) => Math.min(MAX_ARTIFACT_PCT, w + STEP));
  }, []);

  const shrinkArtifact = useCallback(() => {
    setArtifactWidthPct((w) => Math.max(MIN_ARTIFACT_PCT, w - STEP));
  }, []);

  const resetWidth = useCallback(() => {
    setArtifactWidthPct(DEFAULT_ARTIFACT_PCT);
  }, []);

  return {
    artifactWidthPct,
    chatWidthPct: 100 - artifactWidthPct,
    growArtifact,
    shrinkArtifact,
    resetWidth,
  };
}
