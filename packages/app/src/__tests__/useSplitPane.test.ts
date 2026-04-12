/**
 * Tests for useSplitPane hook.
 *
 * Uses the ink-testing-library renderHook pattern (same as useArtifacts) —
 * no jsdom required. Calling hook methods directly triggers React state
 * updates that propagate synchronously within Ink's render loop.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import { Text } from 'ink';
import { useSplitPane, type UseSplitPaneResult } from '../hooks/useSplitPane.js';

// ─── Hook test harness ────────────────────────────────────────────────────────

function renderUseSplitPane(): {
  hookRef: React.MutableRefObject<UseSplitPaneResult | null>;
} {
  const hookRef: React.MutableRefObject<UseSplitPaneResult | null> = { current: null };

  function Harness() {
    const result = useSplitPane();
    hookRef.current = result;
    return React.createElement(Text, null, String(result.artifactWidthPct));
  }

  render(React.createElement(Harness));
  return { hookRef };
}

afterEach(() => {
  cleanup();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useSplitPane — initial state', () => {
  it('starts at 50% artifact width', () => {
    const { hookRef } = renderUseSplitPane();
    expect(hookRef.current?.artifactWidthPct).toBe(50);
  });

  it('starts at 50% chat width', () => {
    const { hookRef } = renderUseSplitPane();
    expect(hookRef.current?.chatWidthPct).toBe(50);
  });

  it('artifact + chat always sum to 100', () => {
    const { hookRef } = renderUseSplitPane();
    const r = hookRef.current!;
    expect(r.artifactWidthPct + r.chatWidthPct).toBe(100);
  });
});

describe('useSplitPane — growArtifact', () => {
  it('increases artifact width by 5%', () => {
    const { hookRef } = renderUseSplitPane();
    hookRef.current!.growArtifact();
    expect(hookRef.current?.artifactWidthPct).toBe(55);
  });

  it('decreases chat width by 5%', () => {
    const { hookRef } = renderUseSplitPane();
    hookRef.current!.growArtifact();
    expect(hookRef.current?.chatWidthPct).toBe(45);
  });

  it('does not exceed 70% maximum', () => {
    const { hookRef } = renderUseSplitPane();
    // Grow 5 times (50 + 5*5 = 75, capped at 70)
    for (let i = 0; i < 5; i++) {
      hookRef.current!.growArtifact();
    }
    expect(hookRef.current?.artifactWidthPct).toBe(70);
  });

  it('stays at 70% when already at maximum', () => {
    const { hookRef } = renderUseSplitPane();
    for (let i = 0; i < 10; i++) {
      hookRef.current!.growArtifact();
    }
    expect(hookRef.current?.artifactWidthPct).toBe(70);
  });
});

describe('useSplitPane — shrinkArtifact', () => {
  it('decreases artifact width by 5%', () => {
    const { hookRef } = renderUseSplitPane();
    hookRef.current!.shrinkArtifact();
    expect(hookRef.current?.artifactWidthPct).toBe(45);
  });

  it('increases chat width by 5%', () => {
    const { hookRef } = renderUseSplitPane();
    hookRef.current!.shrinkArtifact();
    expect(hookRef.current?.chatWidthPct).toBe(55);
  });

  it('does not go below 30% minimum', () => {
    const { hookRef } = renderUseSplitPane();
    // Shrink 5 times (50 - 5*5 = 25, capped at 30)
    for (let i = 0; i < 5; i++) {
      hookRef.current!.shrinkArtifact();
    }
    expect(hookRef.current?.artifactWidthPct).toBe(30);
  });

  it('stays at 30% when already at minimum', () => {
    const { hookRef } = renderUseSplitPane();
    for (let i = 0; i < 10; i++) {
      hookRef.current!.shrinkArtifact();
    }
    expect(hookRef.current?.artifactWidthPct).toBe(30);
  });
});

describe('useSplitPane — resetWidth', () => {
  it('returns to 50% after grow', () => {
    const { hookRef } = renderUseSplitPane();
    hookRef.current!.growArtifact();
    hookRef.current!.growArtifact();
    expect(hookRef.current?.artifactWidthPct).toBe(60);
    hookRef.current!.resetWidth();
    expect(hookRef.current?.artifactWidthPct).toBe(50);
    expect(hookRef.current?.chatWidthPct).toBe(50);
  });

  it('returns to 50% after shrink', () => {
    const { hookRef } = renderUseSplitPane();
    hookRef.current!.shrinkArtifact();
    hookRef.current!.shrinkArtifact();
    expect(hookRef.current?.artifactWidthPct).toBe(40);
    hookRef.current!.resetWidth();
    expect(hookRef.current?.artifactWidthPct).toBe(50);
  });

  it('returns to 50% when already at 50%', () => {
    const { hookRef } = renderUseSplitPane();
    hookRef.current!.resetWidth();
    expect(hookRef.current?.artifactWidthPct).toBe(50);
  });
});

describe('useSplitPane — invariants', () => {
  it('artifact + chat always sum to 100 after grow', () => {
    const { hookRef } = renderUseSplitPane();
    hookRef.current!.growArtifact();
    const r = hookRef.current!;
    expect(r.artifactWidthPct + r.chatWidthPct).toBe(100);
  });

  it('artifact + chat always sum to 100 after shrink', () => {
    const { hookRef } = renderUseSplitPane();
    hookRef.current!.shrinkArtifact();
    const r = hookRef.current!;
    expect(r.artifactWidthPct + r.chatWidthPct).toBe(100);
  });

  it('artifact + chat always sum to 100 at max', () => {
    const { hookRef } = renderUseSplitPane();
    for (let i = 0; i < 10; i++) {
      hookRef.current!.growArtifact();
    }
    const r = hookRef.current!;
    expect(r.artifactWidthPct + r.chatWidthPct).toBe(100);
  });

  it('artifact + chat always sum to 100 at min', () => {
    const { hookRef } = renderUseSplitPane();
    for (let i = 0; i < 10; i++) {
      hookRef.current!.shrinkArtifact();
    }
    const r = hookRef.current!;
    expect(r.artifactWidthPct + r.chatWidthPct).toBe(100);
  });
});
