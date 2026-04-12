/**
 * Tests for useArtifacts hook.
 *
 * The hook manages a single "active artifact" slot — promoting replaces
 * whatever was previously active. There is no multi-artifact list.
 *
 * Strategy: render a thin wrapper component via ink-testing-library to drive
 * the hook from inside React, then observe shared state via a captured ref.
 * This tests observable behaviour (state transitions) without touching
 * implementation details like internal setState calls.
 */

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React, { useEffect } from 'react';
import { Text } from 'ink';
import { useArtifacts, PROMOTE_THRESHOLD, type UseArtifactsResult } from '../hooks/useArtifacts.js';
import type { Artifact } from '../components/artifacts/ArtifactPanel.js';

// ─── Shared test data ─────────────────────────────────────────────────────────

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'artifact-1',
    language: 'typescript',
    title: 'My Component',
    original: 'const x = 1;',
    code: 'const x = 1;',
    ...overrides,
  };
}

// ─── Hook test harness ────────────────────────────────────────────────────────

/**
 * Renders useArtifacts inside a minimal Ink tree.
 * The returned `ref.current` holds the live hook result — updated
 * synchronously with each re-render.
 */
function renderUseArtifacts(): {
  hookRef: React.MutableRefObject<UseArtifactsResult | null>;
  cleanup: () => void;
} {
  const hookRef: React.MutableRefObject<UseArtifactsResult | null> = { current: null };

  function Harness() {
    const result = useArtifacts();
    // Write into the ref so tests can read state without re-rendering
    useEffect(() => {
      hookRef.current = result;
    });
    // Also sync during render phase for immediate reads after act-equivalent calls
    hookRef.current = result;
    return React.createElement(Text, null, 'harness');
  }

  const instance = render(React.createElement(Harness));
  return { hookRef, cleanup: instance.cleanup };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useArtifacts', () => {
  describe('initial state', () => {
    it('starts with no active artifact', () => {
      const { hookRef, cleanup } = renderUseArtifacts();
      expect(hookRef.current?.activeArtifact).toBeNull();
      cleanup();
    });

    it('exposes all four API methods', () => {
      const { hookRef, cleanup } = renderUseArtifacts();
      expect(typeof hookRef.current?.promoteArtifact).toBe('function');
      expect(typeof hookRef.current?.dismissArtifact).toBe('function');
      expect(typeof hookRef.current?.updateArtifact).toBe('function');
      cleanup();
    });
  });

  describe('promoteArtifact', () => {
    it('sets the active artifact to the promoted one', () => {
      const { hookRef, cleanup } = renderUseArtifacts();
      const artifact = makeArtifact();

      hookRef.current!.promoteArtifact(artifact);

      expect(hookRef.current!.activeArtifact).toEqual(artifact);
      cleanup();
    });

    it('replaces an existing active artifact when a different one is promoted', () => {
      const { hookRef, cleanup } = renderUseArtifacts();
      const first = makeArtifact({ id: 'artifact-1', title: 'First' });
      const second = makeArtifact({ id: 'artifact-2', title: 'Second' });

      hookRef.current!.promoteArtifact(first);
      hookRef.current!.promoteArtifact(second);

      expect(hookRef.current!.activeArtifact?.id).toBe('artifact-2');
      expect(hookRef.current!.activeArtifact?.title).toBe('Second');
      cleanup();
    });

    it('re-promoting the same id replaces the artifact (last write wins)', () => {
      const { hookRef, cleanup } = renderUseArtifacts();
      const v1 = makeArtifact({ id: 'artifact-1', code: 'const x = 1;' });
      const v2 = makeArtifact({ id: 'artifact-1', code: 'const x = 999;' });

      hookRef.current!.promoteArtifact(v1);
      hookRef.current!.promoteArtifact(v2);

      expect(hookRef.current!.activeArtifact?.code).toBe('const x = 999;');
      cleanup();
    });

    it('preserves all artifact fields after promotion', () => {
      const { hookRef, cleanup } = renderUseArtifacts();
      const artifact = makeArtifact({
        id: 'full-artifact',
        language: 'python',
        title: 'Script',
        original: 'x = 1',
        code: 'x = 2',
      });

      hookRef.current!.promoteArtifact(artifact);

      expect(hookRef.current!.activeArtifact).toEqual(artifact);
      cleanup();
    });
  });

  describe('dismissArtifact', () => {
    it('clears the active artifact', () => {
      const { hookRef, cleanup } = renderUseArtifacts();

      hookRef.current!.promoteArtifact(makeArtifact());
      hookRef.current!.dismissArtifact();

      expect(hookRef.current!.activeArtifact).toBeNull();
      cleanup();
    });

    it('is a no-op when there is no active artifact', () => {
      const { hookRef, cleanup } = renderUseArtifacts();

      expect(() => hookRef.current!.dismissArtifact()).not.toThrow();
      expect(hookRef.current!.activeArtifact).toBeNull();
      cleanup();
    });
  });

  describe('updateArtifact', () => {
    it('updates the code of the active artifact when ids match', () => {
      const { hookRef, cleanup } = renderUseArtifacts();
      hookRef.current!.promoteArtifact(makeArtifact({ id: 'a1', code: 'const x = 1;' }));

      hookRef.current!.updateArtifact('a1', { code: 'const x = 42;' });

      expect(hookRef.current!.activeArtifact?.code).toBe('const x = 42;');
      cleanup();
    });

    it('preserves all other fields when updating code', () => {
      const { hookRef, cleanup } = renderUseArtifacts();
      const artifact = makeArtifact({ id: 'a1', language: 'go', title: 'Main', original: 'old' });
      hookRef.current!.promoteArtifact(artifact);

      hookRef.current!.updateArtifact('a1', { code: 'new code' });

      const active = hookRef.current!.activeArtifact!;
      expect(active.language).toBe('go');
      expect(active.title).toBe('Main');
      expect(active.original).toBe('old');
      expect(active.id).toBe('a1');
      cleanup();
    });

    it('does nothing when the id does not match the active artifact', () => {
      const { hookRef, cleanup } = renderUseArtifacts();
      const original = makeArtifact({ id: 'a1', code: 'original' });
      hookRef.current!.promoteArtifact(original);

      hookRef.current!.updateArtifact('wrong-id', { code: 'changed' });

      expect(hookRef.current!.activeArtifact?.code).toBe('original');
      cleanup();
    });

    it('does nothing when there is no active artifact', () => {
      const { hookRef, cleanup } = renderUseArtifacts();

      expect(() => hookRef.current!.updateArtifact('a1', { code: 'x' })).not.toThrow();
      expect(hookRef.current!.activeArtifact).toBeNull();
      cleanup();
    });
  });

  describe('PROMOTE_THRESHOLD constant', () => {
    it('is set to 15', () => {
      expect(PROMOTE_THRESHOLD).toBe(15);
    });
  });
});
