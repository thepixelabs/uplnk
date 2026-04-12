/**
 * Unit tests for the unified diff patch applier (applyUnifiedDiff).
 *
 * These tests import the function directly from file-browse.ts and exercise
 * the patch parsing logic in isolation — no McpServer, no I/O.
 *
 * The file-browse server intentionally performs no security validation; all
 * security checks live in McpManager (see McpManager.test.ts for those tests).
 */

import { describe, it, expect } from 'vitest';
import { applyUnifiedDiff } from '../file-browse.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal well-formed unified diff for a single-line replacement. */
function singleLinePatch(from: string, to: string): string {
  return `--- a/file\n+++ b/file\n@@ -1,1 +1,1 @@\n-${from}\n+${to}\n`;
}

// ─── basic apply ─────────────────────────────────────────────────────────────

describe('applyUnifiedDiff — basic apply', () => {
  it('replaces a single line', () => {
    const original = 'hello world';
    const patch = singleLinePatch('hello world', 'goodbye world');
    expect(applyUnifiedDiff(original, patch)).toBe('goodbye world');
  });

  it('adds a line after an existing line', () => {
    const original = 'line1\nline2';
    const patch = `--- a/file\n+++ b/file\n@@ -1,1 +1,2 @@\n line1\n+inserted\n`;
    expect(applyUnifiedDiff(original, patch)).toBe('line1\ninserted\nline2');
  });

  it('removes a line', () => {
    const original = 'keep\nremove me\nalso keep';
    const patch = `--- a/file\n+++ b/file\n@@ -1,3 +1,2 @@\n keep\n-remove me\n also keep\n`;
    expect(applyUnifiedDiff(original, patch)).toBe('keep\nalso keep');
  });

  it('handles multi-line replacement with context', () => {
    const original = 'alpha\nbeta\ngamma\ndelta';
    // @@ -1,4 +1,4 @@ — replace beta/gamma with BETA/GAMMA, keep alpha/delta as context
    const patch = `--- a/file\n+++ b/file\n@@ -1,4 +1,4 @@\n alpha\n-beta\n-gamma\n+BETA\n+GAMMA\n delta\n`;
    expect(applyUnifiedDiff(original, patch)).toBe('alpha\nBETA\nGAMMA\ndelta');
  });

  it('preserves trailing newline', () => {
    const original = 'foo\n';
    const patch = singleLinePatch('foo', 'bar');
    // The last \n becomes an empty string in the split — both original and result end with \n
    const result = applyUnifiedDiff(original, patch);
    expect(result.endsWith('\n')).toBe(true);
  });

  it('applies a patch that only adds lines to an empty file', () => {
    const original = '';
    const patch = `--- a/file\n+++ b/file\n@@ -0,0 +1,2 @@\n+first line\n+second line\n`;
    const result = applyUnifiedDiff(original, patch);
    expect(result).toContain('first line');
    expect(result).toContain('second line');
  });
});

// ─── multiple hunks ───────────────────────────────────────────────────────────

describe('applyUnifiedDiff — multiple hunks', () => {
  it('applies two independent hunks in the same patch', () => {
    const original = 'a\nb\nc\nd\ne\nf';
    const patch =
      `--- a/file\n+++ b/file\n` +
      `@@ -1,1 +1,1 @@\n-a\n+A\n` +
      `@@ -5,1 +5,1 @@\n-e\n+E\n`;
    expect(applyUnifiedDiff(original, patch)).toBe('A\nb\nc\nd\nE\nf');
  });

  it('accounts for line offset between hunks', () => {
    // First hunk inserts one line, second hunk references original line numbers.
    const original = 'x\ny\nz';
    const patch =
      `--- a/file\n+++ b/file\n` +
      `@@ -1,1 +1,2 @@\n-x\n+x1\n+x2\n` +
      `@@ -3,1 +4,1 @@\n-z\n+Z\n`;
    expect(applyUnifiedDiff(original, patch)).toBe('x1\nx2\ny\nZ');
  });
});

// ─── error cases ──────────────────────────────────────────────────────────────

describe('applyUnifiedDiff — error handling', () => {
  it('throws when there are no @@ markers', () => {
    expect(() => applyUnifiedDiff('anything', '--- a/f\n+++ b/f\n')).toThrow(
      /No hunks found/,
    );
  });

  it('throws on a malformed hunk header', () => {
    const patch = `--- a/f\n+++ b/f\n@@ not-a-hunk @@\n-old\n+new\n`;
    expect(() => applyUnifiedDiff('old', patch)).toThrow(/Malformed hunk header/);
  });

  it('throws when a context line does not match the file content', () => {
    const original = 'correct line';
    const patch = `--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-wrong line\n+new line\n`;
    expect(() => applyUnifiedDiff(original, patch)).toThrow(/does not apply/);
  });

  it('throws when a removal line references a non-existent line', () => {
    // File has 1 line but hunk tries to touch line 5
    const original = 'only line';
    const patch = `--- a/f\n+++ b/f\n@@ -5,1 +5,1 @@\n-ghost\n+new\n`;
    expect(() => applyUnifiedDiff(original, patch)).toThrow(/does not apply/);
  });
});

// ─── edge cases ───────────────────────────────────────────────────────────────

describe('applyUnifiedDiff — edge cases', () => {
  it('ignores \\ No newline at end of file markers', () => {
    const original = 'foo';
    const patch = `--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-foo\n\\ No newline at end of file\n+bar\n\\ No newline at end of file\n`;
    expect(applyUnifiedDiff(original, patch)).toBe('bar');
  });

  it('handles hunk header without count (N defaults to 1)', () => {
    const original = 'only';
    const patch = `--- a/f\n+++ b/f\n@@ -1 +1 @@\n-only\n+replaced\n`;
    expect(applyUnifiedDiff(original, patch)).toBe('replaced');
  });

  it('skips diff --git and index header lines before first hunk', () => {
    const original = 'foo';
    const patch =
      `diff --git a/file b/file\n` +
      `index abc..def 100644\n` +
      `--- a/file\n` +
      `+++ b/file\n` +
      `@@ -1,1 +1,1 @@\n-foo\n+bar\n`;
    expect(applyUnifiedDiff(original, patch)).toBe('bar');
  });
});
