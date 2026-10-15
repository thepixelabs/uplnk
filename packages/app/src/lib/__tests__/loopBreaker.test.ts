/**
 * loopBreaker — unit tests for the signature hasher and the rolling-window
 * loop detector.
 */

import { describe, it, expect } from 'vitest';
import {
  hashToolArgs,
  LoopBreaker,
  makeSignature,
  type ToolCallSignature,
} from '../loopBreaker.js';

describe('hashToolArgs', () => {
  it('returns the same hash for objects with differently-ordered keys', () => {
    const a = hashToolArgs({ a: 1, b: 2, c: 3 });
    const b = hashToolArgs({ c: 3, b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it('distinguishes objects with different values', () => {
    const a = hashToolArgs({ q: 'foo' });
    const b = hashToolArgs({ q: 'bar' });
    expect(a).not.toBe(b);
  });

  it('distinguishes nested object differences', () => {
    const a = hashToolArgs({ q: { page: 1, limit: 10 } });
    const b = hashToolArgs({ q: { page: 2, limit: 10 } });
    expect(a).not.toBe(b);
  });

  it('handles nested objects deterministically regardless of key order', () => {
    const a = hashToolArgs({ outer: { x: 1, y: 2 }, k: 'v' });
    const b = hashToolArgs({ k: 'v', outer: { y: 2, x: 1 } });
    expect(a).toBe(b);
  });

  it('handles arrays and preserves element order', () => {
    expect(hashToolArgs([1, 2, 3])).toBe(hashToolArgs([1, 2, 3]));
    expect(hashToolArgs([1, 2, 3])).not.toBe(hashToolArgs([3, 2, 1]));
  });

  it('distinguishes nested array contents', () => {
    const a = hashToolArgs({ tags: ['rust', 'wasm'] });
    const b = hashToolArgs({ tags: ['rust', 'wasm', 'extra'] });
    expect(a).not.toBe(b);
  });

  it('handles null, primitives, and undefined as distinct values', () => {
    expect(hashToolArgs(null)).not.toBe(hashToolArgs(undefined));
    expect(hashToolArgs(0)).not.toBe(hashToolArgs('0'));
    expect(hashToolArgs(false)).not.toBe(hashToolArgs(null));
  });

  it('distinguishes `{x: undefined}` from `{}`', () => {
    expect(hashToolArgs({ x: undefined })).not.toBe(hashToolArgs({}));
  });

  it('throws on unsupported types (function, symbol, bigint)', () => {
    expect(() => hashToolArgs(() => 0)).toThrow(TypeError);
    expect(() => hashToolArgs(Symbol('s'))).toThrow(TypeError);
    expect(() => hashToolArgs(BigInt(1))).toThrow(TypeError);
  });

  it('produces a 64-char lowercase hex digest (sha256 shape)', () => {
    const h = hashToolArgs({ q: 'hello' });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('makeSignature', () => {
  it('combines toolName and argsHash', () => {
    const sig = makeSignature('web_search', { q: 'rust' });
    expect(sig.toolName).toBe('web_search');
    expect(sig.argsHash).toBe(hashToolArgs({ q: 'rust' }));
  });
});

describe('LoopBreaker', () => {
  const sig = (name: string, args: unknown): ToolCallSignature => makeSignature(name, args);

  it('returns continue on a single observation', () => {
    const lb = new LoopBreaker();
    expect(lb.observe(sig('web_search', { q: 'rust' }))).toEqual({ action: 'continue' });
  });

  it('returns continue for 3 identical signatures under the default threshold of 4', () => {
    const lb = new LoopBreaker();
    const s = sig('web_search', { q: 'rust' });
    expect(lb.observe(s)).toEqual({ action: 'continue' });
    expect(lb.observe(s)).toEqual({ action: 'continue' });
    expect(lb.observe(s)).toEqual({ action: 'continue' });
  });

  it('returns force-answer with stuck reason on the 4th identical signature', () => {
    const lb = new LoopBreaker();
    const s = sig('web_search', { q: 'rust' });
    lb.observe(s);
    lb.observe(s);
    lb.observe(s);
    const v = lb.observe(s);
    expect(v.action).toBe('force-answer');
    if (v.action === 'force-answer') {
      expect(v.reason).toMatch(/identical args/);
      expect(v.reason).toContain('web_search');
      expect(v.reason).toContain('4');
    }
  });

  it('returns continue for 14 same-tool different-args calls under the default limit of 15', () => {
    const lb = new LoopBreaker();
    for (let i = 0; i < 14; i++) {
      expect(lb.observe(sig('web_search', { q: `topic-${i}` })).action).toBe('continue');
    }
  });

  it('returns force-answer with same-tool reason on the 15th same-tool different-args call', () => {
    const lb = new LoopBreaker();
    for (let i = 0; i < 14; i++) {
      lb.observe(sig('web_search', { q: `topic-${i}` }));
    }
    const v = lb.observe(sig('web_search', { q: 'topic-14' }));
    expect(v.action).toBe('force-answer');
    if (v.action === 'force-answer') {
      expect(v.reason).toMatch(/15 times this turn/);
      expect(v.reason).toContain('web_search');
    }
  });

  it('reset() clears state — 4 identical + reset + 3 more identical → continue', () => {
    const lb = new LoopBreaker();
    const s = sig('web_search', { q: 'rust' });
    lb.observe(s);
    lb.observe(s);
    lb.observe(s);
    expect(lb.observe(s).action).toBe('force-answer');

    lb.reset();
    expect(lb.snapshot().stuckCount).toBe(0);
    expect(lb.snapshot().recentSignatures).toHaveLength(0);
    expect(lb.snapshot().perToolCallCounts).toEqual({});

    expect(lb.observe(s).action).toBe('continue');
    expect(lb.observe(s).action).toBe('continue');
    expect(lb.observe(s).action).toBe('continue');
  });

  it('does not flag interleaved different tools as a loop', () => {
    const lb = new LoopBreaker();
    const a = sig('web_search', { q: 'rust' });
    const b = sig('file_read', { path: '/tmp/x' });
    expect(lb.observe(a).action).toBe('continue');
    expect(lb.observe(b).action).toBe('continue');
    expect(lb.observe(a).action).toBe('continue');
    expect(lb.observe(b).action).toBe('continue');
    expect(lb.observe(a).action).toBe('continue');
    expect(lb.observe(b).action).toBe('continue');
    expect(lb.snapshot().stuckCount).toBe(1);
  });

  it('window slides — only the last N signatures are retained in snapshot', () => {
    // Pick threshold/limit high enough that observations never trip a verdict.
    const lb = new LoopBreaker({
      signatureWindow: 3,
      stuckRoundThreshold: 99,
      sameToolCallLimit: 99,
    });
    lb.observe(sig('a', {}));
    lb.observe(sig('b', {}));
    lb.observe(sig('c', {}));
    lb.observe(sig('d', {}));
    const snap = lb.snapshot();
    expect(snap.recentSignatures).toHaveLength(3);
    expect(snap.recentSignatures.map((s) => s.toolName)).toEqual(['b', 'c', 'd']);
  });

  it('trailing-run length resets when a different signature is observed', () => {
    const lb = new LoopBreaker({ signatureWindow: 6, stuckRoundThreshold: 99 });
    const s = sig('web_search', { q: 'rust' });
    const other = sig('web_search', { q: 'wasm' });
    lb.observe(s);
    lb.observe(s);
    lb.observe(s);
    expect(lb.snapshot().stuckCount).toBe(3);
    lb.observe(other);
    expect(lb.snapshot().stuckCount).toBe(1);
    lb.observe(s);
    expect(lb.snapshot().stuckCount).toBe(1);
  });

  it('snapshot returns frozen views that cannot be mutated by callers', () => {
    const lb = new LoopBreaker();
    lb.observe(sig('web_search', { q: 'rust' }));
    const snap = lb.snapshot();

    // recentSignatures is a frozen readonly array.
    expect(() => {
      (snap.recentSignatures as ToolCallSignature[]).push(sig('x', {}));
    }).toThrow();

    // Each entry is also frozen.
    expect(() => {
      (snap.recentSignatures[0] as { toolName: string }).toolName = 'mutated';
    }).toThrow();

    // perToolCallCounts is frozen.
    expect(() => {
      (snap.perToolCallCounts as Record<string, number>).newKey = 99;
    }).toThrow();
  });

  it('snapshot reflects per-tool counts cumulatively across the turn', () => {
    const lb = new LoopBreaker({ sameToolCallLimit: 99 });
    lb.observe(sig('web_search', { q: 'a' }));
    lb.observe(sig('web_search', { q: 'b' }));
    lb.observe(sig('file_read', { path: '/x' }));
    expect(lb.snapshot().perToolCallCounts).toEqual({
      web_search: 2,
      file_read: 1,
    });
  });

  it('honors custom thresholds passed to the constructor', () => {
    const lb = new LoopBreaker({ stuckRoundThreshold: 2 });
    const s = sig('web_search', { q: 'rust' });
    expect(lb.observe(s).action).toBe('continue');
    expect(lb.observe(s).action).toBe('force-answer');
  });

  it('treats key-reordered args as identical for stuck-run detection', () => {
    // Underlines that the detector relies on hashToolArgs stability, not
    // reference identity of the args object.
    const lb = new LoopBreaker();
    lb.observe(makeSignature('web_search', { q: 'rust', limit: 5 }));
    lb.observe(makeSignature('web_search', { limit: 5, q: 'rust' }));
    lb.observe(makeSignature('web_search', { q: 'rust', limit: 5 }));
    const v = lb.observe(makeSignature('web_search', { limit: 5, q: 'rust' }));
    expect(v.action).toBe('force-answer');
  });
});
