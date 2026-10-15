/**
 * contextBudget — unit tests for the adaptive per-call trim.
 */

import { describe, it, expect } from 'vitest';
import type { CoreMessage } from 'ai';
import {
  computeInputBudget,
  estimateMessageTokens,
  trimMessagesForContext,
} from '../contextBudget.js';

function userMsg(text: string): CoreMessage {
  return { role: 'user', content: text };
}

function assistantMsg(text: string): CoreMessage {
  return { role: 'assistant', content: text };
}

/** Generate a string with a known approximateTokens estimate of ~tokens. */
function makeTextOfTokens(tokens: number): string {
  // approximateTokens uses Math.ceil(len / 4); chars = tokens * 4 gives exactly `tokens`.
  return 'x'.repeat(tokens * 4);
}

describe('computeInputBudget', () => {
  it('returns floor(contextWindow * 0.85) by default', () => {
    expect(computeInputBudget({ contextWindow: 4096 })).toBe(Math.floor(4096 * 0.85));
    expect(computeInputBudget({ contextWindow: 128_000 })).toBe(Math.floor(128_000 * 0.85));
  });

  it('respects a custom inputBudgetRatio', () => {
    expect(computeInputBudget({ contextWindow: 1000, inputBudgetRatio: 0.5 })).toBe(500);
  });

  it('reserveForOutput overrides the ratio', () => {
    expect(computeInputBudget({ contextWindow: 4096, reserveForOutput: 1024 })).toBe(3072);
    // even if ratio is also set
    expect(computeInputBudget({ contextWindow: 4096, reserveForOutput: 1024, inputBudgetRatio: 0.1 })).toBe(3072);
  });

  it('clamps to zero when reserve exceeds context', () => {
    expect(computeInputBudget({ contextWindow: 100, reserveForOutput: 1000 })).toBe(0);
  });
});

describe('estimateMessageTokens', () => {
  it('returns 0 for undefined content', () => {
    expect(estimateMessageTokens({ role: 'assistant', content: undefined } as unknown as CoreMessage)).toBe(0);
  });

  it('approximates string content as ceil(chars/4)', () => {
    expect(estimateMessageTokens(userMsg('abcd'))).toBe(1);
    expect(estimateMessageTokens(userMsg('abcde'))).toBe(2);
  });

  it('sums tokens across array content parts', () => {
    const msg: CoreMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'abcd' }, // 1
        { type: 'tool-call', toolCallId: 'c1', toolName: 'foo', args: { x: 'yyyy' } }, // toolName=1, args JSON ~3
      ],
    };
    const n = estimateMessageTokens(msg);
    expect(n).toBeGreaterThan(0);
  });
});

describe('trimMessagesForContext', () => {
  it('returns input unchanged when total fits the budget', () => {
    const input: CoreMessage[] = [
      userMsg('hello'),
      assistantMsg('hi'),
      userMsg('how are you'),
    ];
    const res = trimMessagesForContext(input, { contextWindow: 4096 });
    expect(res.trimmed).toBe(false);
    expect(res.droppedCount).toBe(0);
    expect(res.messages).toEqual(input);
    expect(res.estimatedInputTokens).toBeLessThanOrEqual(res.inputBudget);
  });

  it('does not mutate the input array', () => {
    const input: CoreMessage[] = [
      userMsg(makeTextOfTokens(100)),
      userMsg(makeTextOfTokens(100)),
      userMsg('final'),
    ];
    const snapshot = JSON.stringify(input);
    trimMessagesForContext(input, { contextWindow: 100, protectRecent: 1 });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('returns empty output with budget metadata for empty input', () => {
    const res = trimMessagesForContext([], { contextWindow: 4096 });
    expect(res.messages).toEqual([]);
    expect(res.trimmed).toBe(false);
    expect(res.droppedCount).toBe(0);
    expect(res.estimatedInputTokens).toBe(0);
    expect(res.inputBudget).toBe(Math.floor(4096 * 0.85));
  });

  it('drops oldest first, preserves the last protectRecent messages', () => {
    // 6 messages * 100 tokens each = 600. Budget 250. protectRecent=2 means
    // we must keep at least the last 2 messages (200 tokens). The dropper
    // should drop messages 0..3 (4 oldest) leaving 4..5 = 200 tokens ≤ 250.
    const input: CoreMessage[] = [];
    for (let i = 0; i < 6; i++) input.push(userMsg(makeTextOfTokens(100)));
    const res = trimMessagesForContext(input, {
      contextWindow: 1000,
      inputBudgetRatio: 0.25, // budget = 250
      protectRecent: 2,
    });
    expect(res.droppedCount).toBe(4);
    expect(res.messages).toHaveLength(2);
    expect(res.messages[0]).toBe(input[4]);
    expect(res.messages[1]).toBe(input[5]);
    expect(res.trimmed).toBe(true);
  });

  it('never drops messages in protectedIndices', () => {
    const input: CoreMessage[] = [
      userMsg(makeTextOfTokens(100)), // 0 — protected
      userMsg(makeTextOfTokens(100)), // 1
      userMsg(makeTextOfTokens(100)), // 2
      userMsg(makeTextOfTokens(100)), // 3
      userMsg('final'), // 4 — last user, always kept
    ];
    const res = trimMessagesForContext(input, {
      contextWindow: 1000,
      inputBudgetRatio: 0.15, // budget = 150
      protectRecent: 1,
      protectedIndices: [0],
    });
    expect(res.messages).toContain(input[0]); // protected
    expect(res.messages[res.messages.length - 1]).toBe(input[4]); // last user
  });

  it('always preserves the last user message even if it is huge', () => {
    const input: CoreMessage[] = [
      userMsg(makeTextOfTokens(50)),
      assistantMsg(makeTextOfTokens(50)),
      userMsg(makeTextOfTokens(10_000)), // larger than budget
    ];
    const res = trimMessagesForContext(input, {
      contextWindow: 1000,
      inputBudgetRatio: 0.1, // budget = 100
      protectRecent: 1,
      truncateOversizedMessages: true,
    });
    const last = res.messages[res.messages.length - 1]!;
    expect(last.role).toBe('user');
    // It is truncated, not dropped: content present but shorter than original.
    expect(typeof last.content).toBe('string');
    expect((last.content as string).length).toBeLessThan(40_000);
    expect(Object.keys(res.truncations).length).toBeGreaterThan(0);
  });

  it('head/tail truncates an oversized single message with a visible notice', () => {
    const huge = makeTextOfTokens(5000); // 20k chars
    const input: CoreMessage[] = [userMsg('seed'), userMsg(huge)];
    const res = trimMessagesForContext(input, {
      contextWindow: 1000,
      inputBudgetRatio: 0.1, // budget = 100
      protectRecent: 2,
      truncateOversizedMessages: true,
    });
    const last = res.messages[res.messages.length - 1]!;
    expect(typeof last.content).toBe('string');
    const body = last.content as string;
    expect(body.length).toBeLessThan(huge.length);
    expect(body).toContain('uplnk-trimmed');
    expect(Object.keys(res.truncations).length).toBeGreaterThan(0);
  });

  it('with truncateOversizedMessages: false, returns over-budget with a notice instead', () => {
    const huge = makeTextOfTokens(5000);
    const input: CoreMessage[] = [userMsg(huge)];
    const res = trimMessagesForContext(input, {
      contextWindow: 1000,
      inputBudgetRatio: 0.1, // budget = 100
      protectRecent: 1,
      truncateOversizedMessages: false,
    });
    // The single message is also the last-user message, so it is protected
    // from dropping; with truncation off, it stays full-size.
    expect(res.messages).toHaveLength(1);
    expect((res.messages[0]!.content as string).length).toBe(huge.length);
    expect(res.estimatedInputTokens).toBeGreaterThan(res.inputBudget);
    expect(res.truncations[0]).toContain('exceeds budget');
  });

  it('surfaces a top-of-output notice when irreducible set still exceeds budget', () => {
    // 3 protected oversize messages + last user message → cannot drop any,
    // truncation off → final notice on index 0.
    const input: CoreMessage[] = [
      userMsg(makeTextOfTokens(500)),
      userMsg(makeTextOfTokens(500)),
      userMsg('final'),
    ];
    const res = trimMessagesForContext(input, {
      contextWindow: 1000,
      inputBudgetRatio: 0.1, // budget = 100
      protectRecent: 3, // all three are recent
      truncateOversizedMessages: false,
    });
    expect(res.truncations[0]).toBeDefined();
    expect(res.truncations[0]).toContain('exceeds budget');
  });

  it('preserves message order after dropping', () => {
    const input: CoreMessage[] = [];
    for (let i = 0; i < 10; i++) input.push(userMsg(`msg-${i}`));
    // Force aggressive trim: budget = ~5 tokens
    const res = trimMessagesForContext(input, {
      contextWindow: 100,
      inputBudgetRatio: 0.05,
      protectRecent: 2,
    });
    // Whatever survives, it should be a strictly-increasing slice by index.
    const indexes = res.messages.map((m) => {
      const text = m.content as string;
      return parseInt(text.split('-')[1] ?? '-1', 10);
    });
    for (let i = 1; i < indexes.length; i++) {
      expect(indexes[i]!).toBeGreaterThan(indexes[i - 1]!);
    }
  });

  it('fixture: 100 messages summing to ~50k tokens, ctxWindow 32k → drops to fit', () => {
    const input: CoreMessage[] = [];
    for (let i = 0; i < 99; i++) {
      input.push(userMsg(makeTextOfTokens(500))); // 500 tokens each → 49,500 total
    }
    input.push(userMsg('what is the answer?'));
    const total = input.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
    expect(total).toBeGreaterThan(49_000);

    const res = trimMessagesForContext(input, {
      contextWindow: 32_000,
      // default 0.85 → budget ~27,200
      protectRecent: 10,
    });
    expect(res.trimmed).toBe(true);
    expect(res.droppedCount).toBeGreaterThan(0);
    expect(res.estimatedInputTokens).toBeLessThanOrEqual(res.inputBudget);
    // Last 10 protectRecent + last user must be preserved.
    expect(res.messages).toContain(input[input.length - 1]);
    expect(res.messages).toContain(input[input.length - 2]);
  });

  it('does not double-count tokens (idempotent under re-trim)', () => {
    const input: CoreMessage[] = [];
    for (let i = 0; i < 20; i++) input.push(userMsg(makeTextOfTokens(100)));
    const first = trimMessagesForContext(input, {
      contextWindow: 1000,
      inputBudgetRatio: 0.5, // budget = 500
      protectRecent: 2,
    });
    const second = trimMessagesForContext(first.messages, {
      contextWindow: 1000,
      inputBudgetRatio: 0.5,
      protectRecent: 2,
    });
    expect(second.trimmed).toBe(false);
    expect(second.messages).toEqual(first.messages);
  });
});
