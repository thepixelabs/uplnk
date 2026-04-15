/**
 * stdoutRenderer.test.ts
 *
 * Tests for StdoutRenderer — the format/emit layer between the streaming AI
 * response and stdout/stderr.  We test all three output formats (plain, json,
 * ndjson) for the happy path, the done path with usage, and the error path.
 * All assertions are on what actually lands on process.stdout / process.stderr
 * because that is the observable contract this module exposes.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spyOnProcess } from '../../../__tests__/helpers/processSpy.js';
import { StdoutRenderer } from '../stdoutRenderer.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRenderer(format: 'plain' | 'json' | 'ndjson', quiet = false) {
  return new StdoutRenderer({ format, quiet });
}

const USAGE = { inputTokens: 12, outputTokens: 34 };

// ── plain format ─────────────────────────────────────────────────────────────

describe('StdoutRenderer — plain format', () => {
  it('writes each delta directly to stdout without JSON wrapping', () => {
    const spy = spyOnProcess();
    const r = makeRenderer('plain');
    r.onDelta('Hello');
    r.onDelta(', world');
    expect(spy.getStdout()).toBe('Hello, world');
    spy.restore();
  });

  it('ignores empty-string deltas', () => {
    const spy = spyOnProcess();
    const r = makeRenderer('plain');
    r.onDelta('');
    r.onDelta('text');
    r.onDelta('');
    expect(spy.getStdout()).toBe('text');
    spy.restore();
  });

  it('appends a trailing newline when response does not end with one', () => {
    const spy = spyOnProcess();
    const r = makeRenderer('plain');
    r.onDelta('no trailing newline');
    r.onDone(USAGE);
    expect(spy.getStdout()).toBe('no trailing newline\n');
    spy.restore();
  });

  it('does NOT append an extra newline when response already ends with one', () => {
    const spy = spyOnProcess();
    const r = makeRenderer('plain');
    r.onDelta('already ends\n');
    r.onDone(USAGE);
    expect(spy.getStdout()).toBe('already ends\n');
    spy.restore();
  });

  it('writes token usage to stderr (not stdout) when quiet is false', () => {
    const spy = spyOnProcess();
    const r = makeRenderer('plain', false);
    r.onDelta('hi\n');
    r.onDone(USAGE);
    expect(spy.getStdout()).toBe('hi\n');
    expect(spy.getStderr()).toContain('12');
    expect(spy.getStderr()).toContain('34');
    spy.restore();
  });

  it('does NOT write token usage to stderr when quiet is true', () => {
    const spy = spyOnProcess();
    const r = makeRenderer('plain', true);
    r.onDelta('hi\n');
    r.onDone(USAGE);
    expect(spy.getStderr()).toBe('');
    spy.restore();
  });

  it('writes error message to stderr on error', () => {
    const spy = spyOnProcess();
    const r = makeRenderer('plain');
    r.onError(new Error('upstream timeout'));
    expect(spy.getStderr()).toContain('upstream timeout');
    expect(spy.getStdout()).toBe('');
    spy.restore();
  });
});

// ── json format ───────────────────────────────────────────────────────────────

describe('StdoutRenderer — json format', () => {
  it('accumulates deltas silently and emits a single JSON object on done', () => {
    const spy = spyOnProcess();
    const r = makeRenderer('json', true /* quiet so no stderr dots */);
    r.onDelta('Hello');
    r.onDelta(', world');
    // Nothing on stdout yet — collection is silent
    expect(spy.getStdout()).toBe('');
    r.onDone(USAGE);
    const out = spy.getStdout();
    const parsed = JSON.parse(out) as { text: string; usage: typeof USAGE };
    expect(parsed.text).toBe('Hello, world');
    expect(parsed.usage).toEqual(USAGE);
    spy.restore();
  });

  it('emits valid JSON terminated by a newline', () => {
    const spy = spyOnProcess();
    const r = makeRenderer('json', true);
    r.onDelta('data');
    r.onDone(USAGE);
    expect(spy.getStdout()).toMatch(/\n$/);
    spy.restore();
  });

  it('writes progress dots to stderr when quiet is false', () => {
    const spy = spyOnProcess();
    const r = makeRenderer('json', false);
    r.onDelta('a');
    r.onDelta('b');
    expect(spy.getStderr()).toContain('.');
    r.onDone(USAGE);
    spy.restore();
  });

  it('does not write progress dots to stderr when quiet is true', () => {
    const spy = spyOnProcess();
    const r = makeRenderer('json', true);
    r.onDelta('a');
    r.onDelta('b');
    expect(spy.getStderr()).toBe('');
    spy.restore();
  });

  it('emits error JSON to stdout so scripts can parse it', () => {
    const spy = spyOnProcess();
    const r = makeRenderer('json', true);
    r.onError(new Error('parse failed'));
    const out = spy.getStdout();
    const parsed = JSON.parse(out) as { error: string };
    expect(parsed.error).toBe('parse failed');
    spy.restore();
  });
});

// ── ndjson format ─────────────────────────────────────────────────────────────

describe('StdoutRenderer — ndjson format', () => {
  it('emits one delta event per onDelta call', () => {
    const spy = spyOnProcess();
    const r = makeRenderer('ndjson');
    r.onDelta('foo');
    r.onDelta('bar');
    const lines = spy.getStdout().trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as { v: number; type: string; text: string };
    expect(first).toEqual({ v: 1, type: 'delta', text: 'foo' });
    const second = JSON.parse(lines[1]!) as { v: number; type: string; text: string };
    expect(second).toEqual({ v: 1, type: 'delta', text: 'bar' });
    spy.restore();
  });

  it('emits a done event with usage on onDone', () => {
    const spy = spyOnProcess();
    const r = makeRenderer('ndjson');
    r.onDelta('hi');
    r.onDone(USAGE);
    const lines = spy.getStdout().trim().split('\n');
    const done = JSON.parse(lines[lines.length - 1]!) as { v: number; type: string; usage: typeof USAGE };
    expect(done).toEqual({ v: 1, type: 'done', usage: USAGE });
    spy.restore();
  });

  it('emits an error event on onError', () => {
    const spy = spyOnProcess();
    const r = makeRenderer('ndjson');
    r.onError(new Error('boom'));
    const line = spy.getStdout().trim();
    const parsed = JSON.parse(line) as { v: number; type: string; message: string };
    expect(parsed).toEqual({ v: 1, type: 'error', message: 'boom' });
    spy.restore();
  });

  it('each output line is valid JSON terminated by exactly one newline', () => {
    const spy = spyOnProcess();
    const r = makeRenderer('ndjson');
    r.onDelta('x');
    r.onDone(USAGE);
    const raw = spy.getStdout();
    // Every non-empty line must parse as JSON
    raw.split('\n').filter(Boolean).forEach((line) => {
      expect(() => JSON.parse(line)).not.toThrow();
    });
    spy.restore();
  });

  it('ignores empty-string deltas and does not emit spurious lines', () => {
    const spy = spyOnProcess();
    const r = makeRenderer('ndjson');
    r.onDelta('');
    expect(spy.getStdout()).toBe('');
    spy.restore();
  });
});
