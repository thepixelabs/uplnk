/**
 * Unit tests for the scrollback line-index utilities.
 *
 * These don't try to reproduce Ink's exact wrapping — they verify that the
 * approximation is monotonic, never crashes on pathological input, and
 * that the windowing math keeps us within the line budget.
 */

import { describe, it, expect } from 'vitest';
import type { Message } from '@uplnk/db';
import {
  countWrappedLines,
  estimateMessageLines,
  buildLineIndex,
  windowByLineOffset,
  messageStartLine,
  totalLines,
} from '../messageLines.js';

function msg(role: Message['role'], content: string, id = `m-${Math.random()}`): Message {
  // Partial shape — only the fields messageLines reads (role, content). The
  // cast is deliberate: the line-index math is purely structural.
  return {
    id,
    conversationId: 'c',
    role,
    content,
    createdAt: new Date().toISOString(),
  } as unknown as Message;
}

describe('countWrappedLines', () => {
  it('returns 1 for empty string', () => {
    expect(countWrappedLines('', 80)).toBe(1);
  });

  it('wraps a long line into ceil(len/cols) rows', () => {
    expect(countWrappedLines('x'.repeat(200), 80)).toBe(3);
  });

  it('treats newlines as hard breaks', () => {
    expect(countWrappedLines('a\nb\nc', 80)).toBe(3);
  });

  it('guards against tiny widths', () => {
    // Uses MIN_CONTENT_COLS internally — should not divide by zero.
    expect(countWrappedLines('xxxxxxxxxxxxxxx', 1)).toBeGreaterThan(0);
  });
});

describe('estimateMessageLines', () => {
  it('accounts for label row + content + margin on user messages', () => {
    const m = msg('user', 'hello world');
    // 1 label + 1 content line + 2 margin = 4
    expect(estimateMessageLines(m, 80)).toBe(4);
  });

  it('accounts for the assistant gutter (cols - 2)', () => {
    // 78 content cols, 78-char message fits in 1 content row
    const m = msg('assistant', 'x'.repeat(78));
    expect(estimateMessageLines(m, 80)).toBe(4);
    // 79 chars wraps into 2 rows
    const longer = msg('assistant', 'x'.repeat(79));
    expect(estimateMessageLines(longer, 80)).toBe(5);
  });

  it('renders system messages on 1 content line + margin', () => {
    const m = msg('system', 'be helpful');
    expect(estimateMessageLines(m, 80)).toBe(3);
  });
});

describe('buildLineIndex / totalLines', () => {
  it('produces a monotonically increasing cumulative tally', () => {
    const messages = [
      msg('user', 'hi'),
      msg('assistant', 'hello back'),
      msg('user', 'tell me about sockets'),
    ];
    const idx = buildLineIndex(messages, 80);
    expect(idx).toHaveLength(3);
    expect(idx[0]!.cumulative).toBeGreaterThan(0);
    expect(idx[1]!.cumulative).toBeGreaterThan(idx[0]!.cumulative);
    expect(idx[2]!.cumulative).toBeGreaterThan(idx[1]!.cumulative);
    expect(totalLines(idx)).toBe(idx[2]!.cumulative);
  });

  it('returns 0 for an empty message list', () => {
    expect(totalLines(buildLineIndex([], 80))).toBe(0);
  });
});

describe('windowByLineOffset', () => {
  const messages = [
    msg('user', 'one'), // ~4 lines
    msg('assistant', 'two'), // ~4 lines
    msg('user', 'three'), // ~4 lines
    msg('assistant', 'four'), // ~4 lines
    msg('user', 'five'), // ~4 lines
  ];
  const idx = buildLineIndex(messages, 80);

  it('returns an empty window when maxLines is 0', () => {
    expect(windowByLineOffset(idx, 0, 0)).toEqual({ startIdx: 0, endIdx: 0 });
  });

  it('starts at the message spanning the top line', () => {
    // Line 0 → first message, window big enough to hold all 5.
    const w = windowByLineOffset(idx, 0, 100);
    expect(w.startIdx).toBe(0);
    expect(w.endIdx).toBe(5);
  });

  it('clips the window to maxLines', () => {
    const w = windowByLineOffset(idx, 0, 8);
    // 8 lines ≈ 2 messages
    expect(w.startIdx).toBe(0);
    expect(w.endIdx).toBeGreaterThanOrEqual(2);
    expect(w.endIdx).toBeLessThanOrEqual(3);
  });

  it('always includes at least one message even if oversized', () => {
    const big = msg('assistant', 'x'.repeat(10_000));
    const bigIdx = buildLineIndex([big], 80);
    const w = windowByLineOffset(bigIdx, 0, 3);
    expect(w.startIdx).toBe(0);
    expect(w.endIdx).toBe(1);
  });

  it('handles empty inputs without throwing', () => {
    expect(windowByLineOffset([], 0, 10)).toEqual({ startIdx: 0, endIdx: 0 });
  });
});

describe('messageStartLine', () => {
  const messages = [msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c')];
  const idx = buildLineIndex(messages, 80);

  it('returns 0 for the first message (1-based idx 1)', () => {
    expect(messageStartLine(idx, 1)).toBe(0);
  });

  it('returns the cumulative of the previous message', () => {
    expect(messageStartLine(idx, 2)).toBe(idx[0]!.cumulative);
    expect(messageStartLine(idx, 3)).toBe(idx[1]!.cumulative);
  });

  it('clamps out-of-range indices to the last message start', () => {
    expect(messageStartLine(idx, 0)).toBe(0);
    // Beyond the end → start of the last message.
    expect(messageStartLine(idx, 99)).toBe(idx[1]!.cumulative);
  });
});
