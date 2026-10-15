/**
 * sanitizeMessages — unit tests for the pre-send defensive pass.
 */

import { describe, it, expect } from 'vitest';
import type { CoreMessage } from 'ai';
import { sanitizeMessages } from '../sanitizeMessages.js';

describe('sanitizeMessages', () => {
  it('returns a new array, leaves input unchanged', () => {
    const input: CoreMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    const out = sanitizeMessages(input);
    expect(out).not.toBe(input);
    expect(input).toHaveLength(2); // not mutated
    expect(out).toHaveLength(2);
  });

  it('passes through a clean conversation unchanged', () => {
    const input: CoreMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ];
    expect(sanitizeMessages(input)).toEqual(input);
  });

  describe('orphan tool message', () => {
    it('drops a tool message with no preceding assistant tool_call', () => {
      const input: CoreMessage[] = [
        { role: 'user', content: 'q' },
        {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: 'ghost-1', toolName: 'x', result: 'y' }],
        },
        { role: 'assistant', content: 'a' },
      ];
      const out = sanitizeMessages(input);
      expect(out.filter((m) => m.role === 'tool')).toHaveLength(0);
    });

    it('drops a tool message whose id does not match the preceding assistant', () => {
      const input: CoreMessage[] = [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'call-1', toolName: 'foo', args: {} },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: 'mismatched', toolName: 'foo', result: 'y' }],
        },
      ];
      const out = sanitizeMessages(input);
      expect(out.filter((m) => m.role === 'tool')).toHaveLength(0);
    });

    it('keeps a matching tool result', () => {
      const input: CoreMessage[] = [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'call-1', toolName: 'foo', args: {} },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'foo', result: 'y' }],
        },
        { role: 'assistant', content: 'done' },
      ];
      const out = sanitizeMessages(input);
      expect(out.filter((m) => m.role === 'tool')).toHaveLength(1);
    });
  });

  describe('unanswered tool call', () => {
    it('drops an unanswered tool-call part from an assistant message', () => {
      const input: CoreMessage[] = [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'thinking...' },
            { type: 'tool-call', toolCallId: 'never-answered', toolName: 'foo', args: {} },
          ],
        },
        { role: 'user', content: 'never mind' },
      ];
      const out = sanitizeMessages(input);
      const assistantMsg = out.find((m) => m.role === 'assistant')!;
      expect(Array.isArray(assistantMsg.content)).toBe(true);
      const parts = assistantMsg.content as Array<{ type: string }>;
      expect(parts.find((p) => p.type === 'tool-call')).toBeUndefined();
      expect(parts.find((p) => p.type === 'text')).toBeDefined();
    });

    it('drops the entire assistant message when only orphan tool-call parts remain', () => {
      const input: CoreMessage[] = [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'orphan', toolName: 'foo', args: {} },
          ],
        },
        { role: 'user', content: 'next' },
      ];
      const out = sanitizeMessages(input);
      expect(out.filter((m) => m.role === 'assistant')).toHaveLength(0);
    });

    it('keeps a tool-call that has a matching result', () => {
      const input: CoreMessage[] = [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'answered', toolName: 'foo', args: {} },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: 'answered', toolName: 'foo', result: 'r' }],
        },
      ];
      const out = sanitizeMessages(input);
      const assistantMsg = out.find((m) => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
    });
  });

  describe('consecutive user messages', () => {
    it('merges two consecutive string-content user messages', () => {
      const input: CoreMessage[] = [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'ok' },
      ];
      const out = sanitizeMessages(input);
      const userMsgs = out.filter((m) => m.role === 'user');
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0]!.content).toBe('first\n\nsecond');
    });

    it('does NOT merge when one is array-content (mixed parts)', () => {
      const input: CoreMessage[] = [
        { role: 'user', content: 'first' },
        { role: 'user', content: [{ type: 'text', text: 'second' }] },
      ];
      const out = sanitizeMessages(input);
      expect(out).toHaveLength(2);
    });

    it('does NOT merge across an interleaved non-user message', () => {
      const input: CoreMessage[] = [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ];
      const out = sanitizeMessages(input);
      expect(out.filter((m) => m.role === 'user')).toHaveLength(2);
    });
  });

  it('chains all three passes correctly on a messy history', () => {
    const input: CoreMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'user', content: 'q1 again' }, // will merge with q1
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'on it' },
          { type: 'tool-call', toolCallId: 'orphan-call', toolName: 'x', args: {} },
        ],
      },
      // orphan tool result for a never-issued call
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'ghost', toolName: 'x', result: 'y' }],
      },
      { role: 'user', content: 'never mind' },
    ];
    const out = sanitizeMessages(input);

    // Merged users at start
    expect(out[0]!.role).toBe('user');
    expect(out[0]!.content).toBe('q1\n\nq1 again');

    // Orphan tool dropped, unanswered tool-call dropped (but assistant text survives)
    const assistantMsg = out.find((m) => m.role === 'assistant')!;
    const parts = assistantMsg.content as Array<{ type: string }>;
    expect(parts.find((p) => p.type === 'tool-call')).toBeUndefined();
    expect(parts.find((p) => p.type === 'text')).toBeDefined();

    expect(out.filter((m) => m.role === 'tool')).toHaveLength(0);
  });
});
