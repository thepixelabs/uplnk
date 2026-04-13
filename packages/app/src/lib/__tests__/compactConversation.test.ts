/**
 * Tests for the /compact helper lib.
 *
 * The helper is a small pure-ish module so we exercise it directly instead
 * of booting ChatScreen. We mock the `ai` SDK's `generateText` so no network
 * call is made, and assert:
 *
 *   1. splitForCompaction picks the right prefix/tail slices
 *   2. summariseMessages passes EVERY summarise-target message to generateText
 *      and returns the trimmed text on success
 *   3. summariseMessages propagates provider errors (so the caller can keep
 *      state untouched) and rejects empty summaries
 *   4. formatSummaryContent wraps text with the visual marker
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '@uplnk/db';

// Hoisted so the vi.mock factory can reference it. Individual tests override
// the return value / implementation as needed.
const mockGenerateText = vi.hoisted(() => vi.fn());

vi.mock('ai', () => ({
  generateText: mockGenerateText,
}));

// Import AFTER the mock declaration so the module picks up the stub.
import {
  splitForCompaction,
  summariseMessages,
  formatSummaryContent,
  COMPACT_KEEP_TAIL,
} from '../compactConversation.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const makeMessage = (id: string, role: Message['role'], content: string): Message => ({
  id,
  conversationId: 'conv-compact',
  role,
  content,
  toolCalls: null,
  toolCallId: null,
  inputTokens: null,
  outputTokens: null,
  timeToFirstToken: null,
  createdAt: '2026-04-13T10:00:00Z',
});

function makeConversation(n: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i++) {
    const role: Message['role'] = i % 2 === 0 ? 'user' : 'assistant';
    out.push(makeMessage(`m${i}`, role, `message body ${i}`));
  }
  return out;
}

// Sentinel stub model — summariseMessages passes it straight through to
// generateText, which we've mocked, so the actual shape doesn't matter.
const stubModel = { __stub: true } as unknown as Parameters<typeof summariseMessages>[0];

beforeEach(() => {
  mockGenerateText.mockReset();
});

// ─── splitForCompaction ───────────────────────────────────────────────────────

describe('splitForCompaction', () => {
  it('keeps the last COMPACT_KEEP_TAIL messages and summarises the rest', () => {
    const msgs = makeConversation(10);
    const { toSummarise, toKeep } = splitForCompaction(msgs);
    expect(toKeep).toHaveLength(COMPACT_KEEP_TAIL);
    expect(toSummarise).toHaveLength(10 - COMPACT_KEEP_TAIL);
    // The tail should be the CHRONOLOGICAL end of the list.
    expect(toKeep.map((m) => m.id)).toEqual(['m4', 'm5', 'm6', 'm7', 'm8', 'm9']);
    expect(toSummarise.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3']);
  });

  it('returns an empty summarise list when there are <= keepTail messages', () => {
    const msgs = makeConversation(COMPACT_KEEP_TAIL);
    const { toSummarise, toKeep } = splitForCompaction(msgs);
    expect(toSummarise).toEqual([]);
    expect(toKeep).toHaveLength(COMPACT_KEEP_TAIL);
  });

  it('honours a custom keepTail override', () => {
    const msgs = makeConversation(5);
    const { toSummarise, toKeep } = splitForCompaction(msgs, 2);
    expect(toSummarise.map((m) => m.id)).toEqual(['m0', 'm1', 'm2']);
    expect(toKeep.map((m) => m.id)).toEqual(['m3', 'm4']);
  });
});

// ─── summariseMessages ────────────────────────────────────────────────────────

describe('summariseMessages', () => {
  it('calls generateText with the active model and every message in toSummarise', async () => {
    mockGenerateText.mockResolvedValueOnce({ text: '  summary body  ' });
    const msgs = makeConversation(10);
    const { toSummarise } = splitForCompaction(msgs);

    const result = await summariseMessages(stubModel, toSummarise);

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const call = mockGenerateText.mock.calls[0]![0] as {
      model: unknown;
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.model).toBe(stubModel);

    // The last CoreMessage is the user turn carrying the transcript.
    const userTurn = call.messages[call.messages.length - 1];
    expect(userTurn).toBeDefined();
    expect(userTurn!.role).toBe('user');
    // EVERY summarise-target message body must appear in the transcript so
    // the model has the full prefix to work with.
    for (const m of toSummarise) {
      expect(userTurn!.content).toContain(m.content!);
    }

    // Trimmed on return.
    expect(result).toBe('summary body');
  });

  it('throws when the provider errors — caller uses this to leave state untouched', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('provider down'));
    const msgs = makeConversation(10);
    const { toSummarise } = splitForCompaction(msgs);

    await expect(summariseMessages(stubModel, toSummarise)).rejects.toThrow('provider down');
  });

  it('throws when the provider returns empty text (treated as a failure)', async () => {
    mockGenerateText.mockResolvedValueOnce({ text: '   ' });
    const msgs = makeConversation(10);
    const { toSummarise } = splitForCompaction(msgs);

    await expect(summariseMessages(stubModel, toSummarise)).rejects.toThrow(/empty/i);
  });
});

// ─── formatSummaryContent ─────────────────────────────────────────────────────

describe('formatSummaryContent', () => {
  it('wraps the summary in the visual marker with the sigma glyph', () => {
    expect(formatSummaryContent('the user asked X')).toBe('[\u2211 Summary: the user asked X]');
  });

  it('trims whitespace so a chatty model does not produce a lopsided marker', () => {
    expect(formatSummaryContent('  padded  ')).toBe('[\u2211 Summary: padded]');
  });
});
