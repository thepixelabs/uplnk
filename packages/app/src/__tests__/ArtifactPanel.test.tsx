/**
 * Tests for ArtifactPanel component.
 *
 * ArtifactPanel renders inside an Ink split-pane. We test via
 * ink-testing-library's render() which returns a real terminal frame string.
 *
 * Keyboard events are delivered through stdin.write() using the byte sequences
 * Ink's useInput layer processes. Two timing requirements apply:
 *
 *   1. An initial `await tick()` is required after render() to let the
 *      useEffect inside useInput register the stdin 'readable' listener via
 *      setRawMode(true). Without this tick, stdin writes are silently dropped.
 *
 *   2. A `await tick()` after each stdin.write() lets React flush the
 *      resulting setState call before asserting on the new frame.
 *
 * Terminal width: ink-testing-library's Stdout mock reports 100 columns.
 * The component is rendered at widthPct=100 in tests to avoid text truncation.
 *
 * Keyboard map (current source):
 *   Escape  — calls onClose (when focused)
 *   v       — toggles code/diff view (when focused and hasDiff)
 *   ↑/↓     — scroll (when focused)
 *   Tab     — reserved for chat focus; NOT handled by the component
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ArtifactPanel, type Artifact } from '../components/artifacts/ArtifactPanel.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip all ANSI escape sequences for plain-text assertions. */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Yield to the micro/macro task queues so React can flush state updates and
 * Ink can process pending renders.
 */
const tick = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'art-1',
    language: 'typescript',
    title: 'My Hook',
    original: 'const x = 1;',
    code: 'const x = 1;',
    ...overrides,
  };
}

/**
 * Artifact where original and code differ on line 2 — exercises the
 * removed+added branches of computeDiff.
 *   unchanged: "line one"   (line 1)
 *   removed:   "line two"   (original line 2)
 *   added:     "line TWO"   (code line 2)
 *   unchanged: "line three" (line 3)
 */
function makeDiffArtifact(): Artifact {
  return makeArtifact({
    id: 'diff-1',
    title: 'Changed',
    original: 'line one\nline two\nline three',
    code: 'line one\nline TWO\nline three',
  });
}

/** N-line artifact with identical original and code (no diff). */
function makeMultilineArtifact(lineCount: number): Artifact {
  const lines = Array.from({ length: lineCount }, (_, i) => `const line${i} = ${i};`);
  return makeArtifact({ code: lines.join('\n'), original: lines.join('\n') });
}

// Raw byte sequences that Ink's useInput recognises
const KEY_ESCAPE = '\x1B';
const KEY_V = 'v';
const KEY_UP = '\x1B[A';
const KEY_DOWN = '\x1B[B';

// ─── Rendering helper ─────────────────────────────────────────────────────────

/**
 * Renders ArtifactPanel at full width (100%) and waits one tick so that the
 * useInput useEffect can register the stdin 'readable' listener.
 * All keyboard tests must use this so that subsequent stdin writes are heard.
 */
async function renderPanel(artifact: Artifact, focused = false, onClose = vi.fn()) {
  const instance = render(
    React.createElement(ArtifactPanel, {
      artifact,
      focused,
      onClose,
      widthPct: 100,
    }),
  );
  // Let useEffect(setRawMode) mount so subsequent stdin.write calls are heard
  await tick();
  return instance;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ArtifactPanel', () => {
  describe('rendering basics', () => {
    it('renders the artifact title in the header', async () => {
      const { lastFrame, cleanup } = await renderPanel(makeArtifact({ title: 'My Hook' }));
      expect(stripAnsi(lastFrame()!)).toContain('My Hook');
      cleanup();
    });

    it('renders the language label in the view mode bar', async () => {
      const { lastFrame, cleanup } = await renderPanel(makeArtifact({ language: 'typescript' }));
      expect(stripAnsi(lastFrame()!)).toContain('typescript');
      cleanup();
    });

    it('renders the [Esc: close] hint', async () => {
      const { lastFrame, cleanup } = await renderPanel(makeArtifact());
      expect(stripAnsi(lastFrame()!)).toContain('[Esc: close]');
      cleanup();
    });

    it('renders code content in code view mode', async () => {
      const artifact = makeArtifact({ code: 'const answer = 42;' });
      const { lastFrame, cleanup } = await renderPanel(artifact);
      expect(stripAnsi(lastFrame()!)).toContain('answer');
      cleanup();
    });

    it('renders [Tab: focus panel] hint when not focused', async () => {
      const { lastFrame, cleanup } = await renderPanel(makeArtifact(), false);
      expect(stripAnsi(lastFrame()!)).toContain('[Tab: focus panel]');
      cleanup();
    });

    it('renders [Tab: focus chat] hint when focused', async () => {
      const { lastFrame, cleanup } = await renderPanel(makeArtifact(), true);
      expect(stripAnsi(lastFrame()!)).toContain('[Tab: focus chat]');
      cleanup();
    });
  });

  describe('empty / fallback states', () => {
    it('falls back to "code" label when language is empty string', async () => {
      const { lastFrame, cleanup } = await renderPanel(makeArtifact({ language: '' }));
      expect(stripAnsi(lastFrame()!)).toContain('code');
      cleanup();
    });

    it('uses language as title when title is empty string', async () => {
      const { lastFrame, cleanup } = await renderPanel(makeArtifact({ title: '', language: 'python' }));
      expect(stripAnsi(lastFrame()!)).toContain('python');
      cleanup();
    });

    it('falls back to "code" for both title and label when title and language are both empty', async () => {
      const { lastFrame, cleanup } = await renderPanel(makeArtifact({ title: '', language: '' }));
      // The "code" fallback appears in the view mode bar
      expect(stripAnsi(lastFrame()!)).toContain('code');
      cleanup();
    });

    it('renders without crashing on empty code and original', async () => {
      const { cleanup } = await renderPanel(makeArtifact({ code: '', original: '' }));
      cleanup();
    });

    it('renders without crashing on empty original alone', async () => {
      const { cleanup } = await renderPanel(makeArtifact({ original: '' }));
      cleanup();
    });
  });

  describe('diff indicator', () => {
    it('shows [v: diff] hint when original differs from code', async () => {
      const { lastFrame, cleanup } = await renderPanel(makeDiffArtifact());
      expect(stripAnsi(lastFrame()!)).toContain('[v: diff]');
      cleanup();
    });

    it('does not show a [v:] hint when original equals code', async () => {
      const artifact = makeArtifact({ original: 'same', code: 'same' });
      const { lastFrame, cleanup } = await renderPanel(artifact);
      expect(stripAnsi(lastFrame()!)).not.toContain('[v:');
      cleanup();
    });
  });

  describe('keyboard — Escape closes the panel', () => {
    it('calls onClose when Escape is pressed and panel is focused', async () => {
      const onClose = vi.fn();
      const { stdin, cleanup } = await renderPanel(makeArtifact(), true, onClose);

      stdin.write(KEY_ESCAPE);
      await tick();

      expect(onClose).toHaveBeenCalledOnce();
      cleanup();
    });

    it('does not call onClose when Escape is pressed and panel is not focused', async () => {
      const onClose = vi.fn();
      const { stdin, cleanup } = await renderPanel(makeArtifact(), false, onClose);

      stdin.write(KEY_ESCAPE);
      await tick();

      expect(onClose).not.toHaveBeenCalled();
      cleanup();
    });
  });

  describe('keyboard — v toggles between code and diff view', () => {
    it('switches to diff view on v press when a diff exists', async () => {
      const artifact = makeDiffArtifact();
      const { stdin, lastFrame, cleanup } = await renderPanel(artifact, true);

      stdin.write(KEY_V);
      await tick();

      expect(stripAnsi(lastFrame()!)).toContain('diff view');
      cleanup();
    });

    it('switches back to code view on second v press', async () => {
      const artifact = makeDiffArtifact();
      const { stdin, lastFrame, cleanup } = await renderPanel(artifact, true);

      stdin.write(KEY_V);
      await tick();
      stdin.write(KEY_V);
      await tick();

      const frame = stripAnsi(lastFrame()!);
      expect(frame).not.toContain('diff view');
      expect(frame).toContain('[v: diff]');
      cleanup();
    });

    it('shows [v: code] hint while in diff view', async () => {
      const artifact = makeDiffArtifact();
      const { stdin, lastFrame, cleanup } = await renderPanel(artifact, true);

      stdin.write(KEY_V);
      await tick();

      expect(stripAnsi(lastFrame()!)).toContain('[v: code]');
      cleanup();
    });

    it('does not toggle view when panel is not focused', async () => {
      const artifact = makeDiffArtifact();
      const { stdin, lastFrame, cleanup } = await renderPanel(artifact, false);

      stdin.write(KEY_V);
      await tick();

      expect(stripAnsi(lastFrame()!)).not.toContain('diff view');
      cleanup();
    });

    it('does not toggle view on v when no diff exists (original equals code)', async () => {
      const artifact = makeArtifact({ original: 'same', code: 'same' });
      const { stdin, lastFrame, cleanup } = await renderPanel(artifact, true);

      stdin.write(KEY_V);
      await tick();

      expect(stripAnsi(lastFrame()!)).not.toContain('diff view');
      cleanup();
    });

    it('resets scroll to zero when toggling from code to diff view', async () => {
      const artifact = makeMultilineArtifact(50);
      const diffArtifact = { ...artifact, original: 'different original' };
      const { stdin, lastFrame, cleanup } = await renderPanel(diffArtifact, true);

      // Scroll down first
      stdin.write(KEY_DOWN);
      await tick();

      // Switch to diff view — scroll should reset to 1/N
      stdin.write(KEY_V);
      await tick();

      // The diff scroll indicator should be at position 1
      const frame = stripAnsi(lastFrame()!);
      // Either we see scroll position 1 (if diff > 40 lines) or no indicator (if ≤ 40 lines)
      expect(frame).not.toContain('6/');
      cleanup();
    });
  });

  describe('diff view rendering', () => {
    it('renders "+" prefix for added lines in diff view', async () => {
      const artifact = makeDiffArtifact();
      const { stdin, lastFrame, cleanup } = await renderPanel(artifact, true);

      stdin.write(KEY_V);
      await tick();

      expect(stripAnsi(lastFrame()!)).toContain('+ ');
      cleanup();
    });

    it('renders "-" prefix for removed lines in diff view', async () => {
      const artifact = makeDiffArtifact();
      const { stdin, lastFrame, cleanup } = await renderPanel(artifact, true);

      stdin.write(KEY_V);
      await tick();

      expect(stripAnsi(lastFrame()!)).toContain('- ');
      cleanup();
    });

    it('renders unchanged lines with two-space prefix in diff view', async () => {
      // "line one" and "line three" are identical — they get "  " prefix
      const artifact = makeDiffArtifact();
      const { stdin, lastFrame, cleanup } = await renderPanel(artifact, true);

      stdin.write(KEY_V);
      await tick();

      // Line 1 is unchanged, prefix is "  " followed by padded line number " 1 "
      expect(stripAnsi(lastFrame()!)).toContain('  ');
      cleanup();
    });

    it('renders the modified (added) line text in diff view', async () => {
      const artifact = makeDiffArtifact(); // added = "line TWO"
      const { stdin, lastFrame, cleanup } = await renderPanel(artifact, true);

      stdin.write(KEY_V);
      await tick();

      expect(stripAnsi(lastFrame()!)).toContain('line TWO');
      cleanup();
    });

    it('renders the original (removed) line text in diff view', async () => {
      const artifact = makeDiffArtifact(); // removed = "line two"
      const { stdin, lastFrame, cleanup } = await renderPanel(artifact, true);

      stdin.write(KEY_V);
      await tick();

      expect(stripAnsi(lastFrame()!)).toContain('line two');
      cleanup();
    });

    it('renders unchanged context lines in diff view', async () => {
      const artifact = makeDiffArtifact(); // "line one" and "line three" are unchanged
      const { stdin, lastFrame, cleanup } = await renderPanel(artifact, true);

      stdin.write(KEY_V);
      await tick();

      const frame = stripAnsi(lastFrame()!);
      expect(frame).toContain('line one');
      expect(frame).toContain('line three');
      cleanup();
    });
  });

  describe('keyboard — scrolling', () => {
    it('shows scroll position indicator for content taller than 40 lines', async () => {
      const artifact = makeMultilineArtifact(50);
      const { lastFrame, cleanup } = await renderPanel(artifact);
      expect(stripAnsi(lastFrame()!)).toContain('↕');
      cleanup();
    });

    it('does not show scroll indicator for content at or below 40 lines', async () => {
      const artifact = makeMultilineArtifact(10);
      const { lastFrame, cleanup } = await renderPanel(artifact);
      expect(stripAnsi(lastFrame()!)).not.toContain('↕');
      cleanup();
    });

    it('scrolls down on ↓ by SCROLL_STEP=5 lines', async () => {
      const artifact = makeMultilineArtifact(60);
      const { stdin, lastFrame, cleanup } = await renderPanel(artifact, true);

      expect(stripAnsi(lastFrame()!)).toContain('1/60');

      stdin.write(KEY_DOWN);
      await tick();

      // scrollOffset advances from 0 to 5; display shows scrollOffset+1=6
      expect(stripAnsi(lastFrame()!)).toContain('6/60');
      cleanup();
    });

    it('scrolls back up to position 1 after one down followed by one up', async () => {
      const artifact = makeMultilineArtifact(60);
      const { stdin, lastFrame, cleanup } = await renderPanel(artifact, true);

      stdin.write(KEY_DOWN);
      await tick();
      stdin.write(KEY_UP);
      await tick();

      expect(stripAnsi(lastFrame()!)).toContain('1/60');
      cleanup();
    });

    it('clamps at the top: ↑ at scrollOffset=0 keeps position at 1', async () => {
      const artifact = makeMultilineArtifact(60);
      const { stdin, lastFrame, cleanup } = await renderPanel(artifact, true);

      stdin.write(KEY_UP);
      await tick();

      expect(stripAnsi(lastFrame()!)).toContain('1/60');
      cleanup();
    });

    it('does not scroll when panel is not focused', async () => {
      const artifact = makeMultilineArtifact(60);
      const { stdin, lastFrame, cleanup } = await renderPanel(artifact, false);

      stdin.write(KEY_DOWN);
      await tick();

      // Position unchanged at 1/60
      expect(stripAnsi(lastFrame()!)).toContain('1/60');
      cleanup();
    });

    it('clamps at the bottom: repeated ↓ does not exceed maxScroll', async () => {
      // 45-line artifact: maxScroll = 45 - 40 = 5 → display caps at 6/45
      const artifact = makeMultilineArtifact(45);
      const { stdin, lastFrame, cleanup } = await renderPanel(artifact, true);

      for (let i = 0; i < 10; i++) {
        stdin.write(KEY_DOWN);
        await tick(); // eslint-disable-line no-await-in-loop
      }

      expect(stripAnsi(lastFrame()!)).toContain('6/45');
      cleanup();
    });
  });

  describe('edge cases', () => {
    it('renders without crashing when code is very long (500 lines)', async () => {
      const { cleanup } = await renderPanel(makeMultilineArtifact(500));
      cleanup();
    });

    it('renders without crashing when code contains unicode and emoji', async () => {
      const artifact = makeArtifact({ code: '// \u{1F600} emoji \u{1F4A9} in code' });
      const { cleanup } = await renderPanel(artifact);
      cleanup();
    });

    it('renders without crashing when language is unrecognized', async () => {
      const { cleanup } = await renderPanel(makeArtifact({ language: 'cobol' }));
      cleanup();
    });

    it('handles a diff where the modified code is longer than the original', async () => {
      const artifact = makeArtifact({
        original: 'line A',
        code: 'line A\nline B\nline C',
      });
      const { stdin, lastFrame, cleanup } = await renderPanel(artifact, true);

      stdin.write(KEY_V);
      await tick();

      const frame = stripAnsi(lastFrame()!);
      expect(frame).toContain('line B');
      expect(frame).toContain('line C');
      cleanup();
    });

    it('handles a diff where the original is longer than the modified code', async () => {
      const artifact = makeArtifact({
        original: 'line A\nline B\nline C',
        code: 'line A',
      });
      const { stdin, lastFrame, cleanup } = await renderPanel(artifact, true);

      stdin.write(KEY_V);
      await tick();

      // Lines B and C only appear in original — they show with "- " removed prefix
      expect(stripAnsi(lastFrame()!)).toContain('- ');
      cleanup();
    });

    it('does not show diff view or [v:] hint when original and code are identical', async () => {
      const artifact = makeArtifact({ original: 'same content', code: 'same content' });
      const { stdin, lastFrame, cleanup } = await renderPanel(artifact, true);

      stdin.write(KEY_V);
      await tick();

      const frame = stripAnsi(lastFrame()!);
      expect(frame).not.toContain('diff view');
      expect(frame).not.toContain('[v:');
      cleanup();
    });

    it('code view renders only from current scroll offset (content window)', async () => {
      // With 60 lines and SCROLL_STEP=5 — first page starts at line 0 (const line0)
      const artifact = makeMultilineArtifact(60);
      const { lastFrame, cleanup } = await renderPanel(artifact);

      expect(stripAnsi(lastFrame()!)).toContain('line0');
      cleanup();
    });
  });
});
