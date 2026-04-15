/**
 * stdinReader.test.ts
 *
 * Tests for readStdin().  We exercise the piped (non-TTY) path only — the
 * interactive TTY path would require a real readline loop which is not
 * practical in a headless test environment.  All tests inject a fake
 * Readable in place of process.stdin to stay at the unit boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Replace process.stdin with a Readable that emits `chunks` then ends.
 * Returns a cleanup function that restores the original stdin.
 */
function fakeStdin(chunks: (string | Buffer)[]): () => void {
  const readable = new Readable({ read() {} });

  // Mark as non-TTY so readStdin takes the piped path
  const original = process.stdin;
  Object.defineProperty(process, 'stdin', {
    value: Object.assign(readable, { isTTY: false }),
    writable: true,
    configurable: true,
  });

  // Push data after the module has had a tick to register listeners
  process.nextTick(() => {
    for (const chunk of chunks) {
      readable.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    readable.push(null); // EOF
  });

  return () => {
    Object.defineProperty(process, 'stdin', {
      value: original,
      writable: true,
      configurable: true,
    });
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('readStdin — piped (non-TTY) mode', () => {
  it('returns the full content of a single-chunk pipe', async () => {
    // We must re-import readStdin fresh each test because the module reads
    // process.stdin at call time, not at import time — so dynamic import is fine.
    const restore = fakeStdin(['hello world']);
    const { readStdin } = await import('../stdinReader.js');
    const result = await readStdin();
    restore();
    expect(result).toBe('hello world');
  });

  it('concatenates multiple chunks into one string', async () => {
    const restore = fakeStdin(['hello ', 'world']);
    const { readStdin } = await import('../stdinReader.js');
    const result = await readStdin();
    restore();
    expect(result).toBe('hello world');
  });

  it('trims leading and trailing whitespace', async () => {
    const restore = fakeStdin(['  \n  trimmed  \n  ']);
    const { readStdin } = await import('../stdinReader.js');
    const result = await readStdin();
    restore();
    expect(result).toBe('trimmed');
  });

  it('returns empty string for an empty pipe', async () => {
    const restore = fakeStdin([]);
    const { readStdin } = await import('../stdinReader.js');
    const result = await readStdin();
    restore();
    expect(result).toBe('');
  });

  it('handles binary-safe Buffer chunks with UTF-8 content', async () => {
    const restore = fakeStdin([Buffer.from('café ☕', 'utf-8')]);
    const { readStdin } = await import('../stdinReader.js');
    const result = await readStdin();
    restore();
    expect(result).toBe('café ☕');
  });

  it('handles a pipe that contains only whitespace', async () => {
    const restore = fakeStdin(['\n\n  \n\t\n']);
    const { readStdin } = await import('../stdinReader.js');
    const result = await readStdin();
    restore();
    expect(result).toBe('');
  });
});

describe('readStdin — stream error propagation', () => {
  it('rejects when the stdin stream emits an error', async () => {
    const readable = new Readable({ read() {} });
    const original = process.stdin;
    Object.defineProperty(process, 'stdin', {
      value: Object.assign(readable, { isTTY: false }),
      writable: true,
      configurable: true,
    });

    process.nextTick(() => {
      readable.destroy(new Error('stdin broken'));
    });

    const { readStdin } = await import('../stdinReader.js');
    await expect(readStdin()).rejects.toThrow('stdin broken');

    Object.defineProperty(process, 'stdin', {
      value: original,
      writable: true,
      configurable: true,
    });
  });
});
