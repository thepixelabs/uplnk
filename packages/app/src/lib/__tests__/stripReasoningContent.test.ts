/**
 * stripReasoningContent — unit tests.
 */

import { describe, it, expect } from 'vitest';
import type { CoreMessage } from 'ai';
import { stripReasoningContent } from '../stripReasoningContent.js';

describe('stripReasoningContent', () => {
  it('returns empty array for empty input', () => {
    expect(stripReasoningContent([])).toEqual([]);
  });

  it('returns a new array, leaves input unchanged', () => {
    const input: CoreMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'reasoning', text: 'private chain-of-thought' },
        ],
      },
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = stripReasoningContent(input);
    expect(out).not.toBe(input);
    expect(input).toEqual(snapshot); // no mutation
  });

  it('returns user-only history unchanged', () => {
    const input: CoreMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'user', content: 'q2' },
    ];
    expect(stripReasoningContent(input)).toEqual(input);
  });

  it('preserves reasoning on a SINGLE assistant message (it IS the last)', () => {
    const input: CoreMessage[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'answer' },
          { type: 'reasoning', text: 'reasoning that must stay' },
        ],
      },
    ];
    const out = stripReasoningContent(input);
    const parts = out[1]!.content as Array<{ type: string }>;
    expect(parts.find((p) => p.type === 'reasoning')).toBeDefined();
  });

  it('strips reasoning from the first assistant when two assistants both carry it', () => {
    const input: CoreMessage[] = [
      { role: 'user', content: 'q1' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a1' },
          { type: 'reasoning', text: 'first-thought' },
        ],
      },
      { role: 'user', content: 'q2' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a2' },
          { type: 'reasoning', text: 'second-thought' },
        ],
      },
    ];
    const out = stripReasoningContent(input);
    const first = out[1]!.content as Array<{ type: string }>;
    const last = out[3]!.content as Array<{ type: string }>;
    expect(first.find((p) => p.type === 'reasoning')).toBeUndefined();
    expect(first.find((p) => p.type === 'text')).toBeDefined();
    expect(last.find((p) => p.type === 'reasoning')).toBeDefined();
  });

  it('drops a reasoning part from a non-last assistant with mixed content', () => {
    const input: CoreMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'reasoning', text: 'stale' },
        ],
      },
      { role: 'user', content: 'follow-up' },
      { role: 'assistant', content: 'done' },
    ];
    const out = stripReasoningContent(input);
    expect(out[0]!.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('drops redacted-reasoning parts too', () => {
    const input: CoreMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a' },
          { type: 'redacted-reasoning', data: 'encrypted-blob' },
        ],
      },
      { role: 'user', content: 'next' },
      { role: 'assistant', content: 'b' },
    ];
    const out = stripReasoningContent(input);
    const parts = out[0]!.content as Array<{ type: string }>;
    expect(parts.find((p) => p.type === 'redacted-reasoning')).toBeUndefined();
    expect(parts.find((p) => p.type === 'text')).toBeDefined();
  });

  it('leaves string-content assistant messages alone', () => {
    const input: CoreMessage[] = [
      { role: 'assistant', content: 'just a string' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'last' },
    ];
    const out = stripReasoningContent(input);
    expect(out[0]!.content).toBe('just a string');
  });

  it('removes top-level reasoning_content from non-last assistant, keeps it on last', () => {
    const input: Array<CoreMessage & { reasoning_content?: string }> = [
      {
        role: 'assistant',
        content: 'first answer',
        reasoning_content: 'ollama-style thought, must be stripped',
      },
      { role: 'user', content: 'follow up' },
      {
        role: 'assistant',
        content: 'second answer',
        reasoning_content: 'still in flight, must be preserved',
      },
    ];
    const out = stripReasoningContent(input) as Array<
      CoreMessage & { reasoning_content?: string }
    >;
    expect(out[0]!.reasoning_content).toBeUndefined();
    expect(out[0]!.content).toBe('first answer');
    expect(out[2]!.reasoning_content).toBe(
      'still in flight, must be preserved',
    );
  });

  it('removes top-level reasoning (OpenAI o-series shape) from non-last assistant', () => {
    const input: Array<CoreMessage & { reasoning?: string }> = [
      {
        role: 'assistant',
        content: 'answer-1',
        reasoning: 'o-series CoT',
      },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'answer-2' },
    ];
    const out = stripReasoningContent(input) as Array<
      CoreMessage & { reasoning?: string }
    >;
    expect(out[0]!.reasoning).toBeUndefined();
    expect(out[0]!.content).toBe('answer-1');
  });

  it('is a no-op for histories with no reasoning anywhere', () => {
    const input: CoreMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a2-text' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 't', args: {} },
        ],
      },
    ];
    const out = stripReasoningContent(input);
    // Same references where nothing changed — cheap reuse.
    expect(out[0]).toBe(input[0]);
    expect(out[1]).toBe(input[1]);
    expect(out[2]).toBe(input[2]);
    expect(out[3]).toBe(input[3]);
  });

  it('handles interleaved user/assistant/user/assistant — only the FIRST assistant is stripped', () => {
    const input: CoreMessage[] = [
      { role: 'user', content: 'u1' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a1' },
          { type: 'reasoning', text: 'stale-1' },
        ],
      },
      { role: 'user', content: 'u2' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a2' },
          { type: 'reasoning', text: 'fresh-2' },
        ],
      },
    ];
    const out = stripReasoningContent(input);
    const a1 = out[1]!.content as Array<{ type: string; text?: string }>;
    const a2 = out[3]!.content as Array<{ type: string; text?: string }>;
    expect(a1).toEqual([{ type: 'text', text: 'a1' }]);
    expect(a2.find((p) => p.type === 'reasoning')?.text).toBe('fresh-2');
  });
});
