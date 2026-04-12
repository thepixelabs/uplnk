/**
 * useConversation — unit tests
 *
 * Conventions (matching the rest of the test suite):
 *  - ink-testing-library's render() drives the React reconciler in a node
 *    environment. A thin HookWrapper component captures the hook return value
 *    in a ref — the same renderHookViaInk pattern used by useArtifacts.test.ts
 *    and ChatInput.test.tsx.
 *  - `uplnk-db` is mocked at the module boundary. The global setup.ts provides
 *    a baseline stub; this file overrides it with a vi.mock() factory that
 *    exposes per-test vi.fn() refs via vi.hoisted().
 *  - Each test has exactly one reason to fail.
 *
 * Hoisting note: vi.mock() factories are hoisted before any const declarations.
 * vi.hoisted() runs at hoist time, making the mock fn refs available to the
 * factory. Do not move the fn() calls into the factory bodies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';

// ─── Hoisted mock refs ────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  db: {} as object,
  createConversation: vi.fn(),
  getConversation: vi.fn(),
  getMessages: vi.fn(),
  insertMessage: vi.fn(),
  touchConversation: vi.fn(),
}));

vi.mock('uplnk-db', () => ({
  db: mocks.db,
  createConversation: mocks.createConversation,
  getConversation: mocks.getConversation,
  getMessages: mocks.getMessages,
  insertMessage: mocks.insertMessage,
  touchConversation: mocks.touchConversation,
}));

const cryptoMocks = vi.hoisted(() => ({ randomUUID: vi.fn<() => string>() }));
vi.stubGlobal('crypto', { randomUUID: cryptoMocks.randomUUID });

// ─── Import under test ────────────────────────────────────────────────────────

import { useConversation } from '../hooks/useConversation.js';
import type { UseConversationResult } from '../hooks/useConversation.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FakeConversation {
  id: string;
  title: string;
  providerId: null;
  modelId: null;
  totalInputTokens: number;
  totalOutputTokens: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: null;
}

interface FakeMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  toolCalls: null;
  toolCallId: null;
  inputTokens: null;
  outputTokens: null;
  timeToFirstToken: null;
  createdAt: string;
}

// ─── Test data factories ──────────────────────────────────────────────────────

const FIXED_UUID = 'aaaaaaaa-0000-0000-0000-000000000001';
const RESUME_UUID = 'bbbbbbbb-0000-0000-0000-000000000002';

function makeConversation(id: string): FakeConversation {
  return {
    id,
    title: 'New conversation',
    providerId: null,
    modelId: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    deletedAt: null,
  };
}

function makeMessage(
  id: string,
  conversationId: string,
  content: string | null = 'hello',
): FakeMessage {
  return {
    id,
    conversationId,
    role: 'user',
    content,
    toolCalls: null,
    toolCallId: null,
    inputTokens: null,
    outputTokens: null,
    timeToFirstToken: null,
    createdAt: '2024-01-01T00:00:00.000Z',
  };
}

// ─── Hook driver ──────────────────────────────────────────────────────────────

/**
 * Renders useConversation inside an Ink component tree.
 * Returns a ref whose `.current` always reflects the latest render.
 * No DOM needed — Ink runs React in a pure Node environment.
 */
function renderHook(resumeId?: string): {
  result: { current: UseConversationResult };
  unmount: () => void;
} {
  type Result = UseConversationResult;
  const result: { current: Result } = {
    current: undefined as unknown as Result,
  };

  function HookWrapper() {
    result.current = useConversation(resumeId);
    return React.createElement(React.Fragment, null);
  }

  const { unmount } = render(React.createElement(HookWrapper));
  return { result, unmount };
}

/** Drain the microtask queue so Ink's async state updates commit. */
const tick = () => new Promise<void>((r) => setImmediate(r));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cryptoMocks.randomUUID.mockReturnValue(FIXED_UUID);
    mocks.createConversation.mockImplementation(
      (_db: object, data: { id: string }) => makeConversation(data.id),
    );
    mocks.getConversation.mockReturnValue(undefined);
    mocks.getMessages.mockReturnValue([]);
    mocks.insertMessage.mockImplementation(
      (_db: object, data: Partial<FakeMessage>) =>
        makeMessage(
          data.id ?? 'msg-default',
          data.conversationId ?? FIXED_UUID,
          data.content ?? null,
        ),
    );
    mocks.touchConversation.mockReturnValue(undefined);
  });

  // ── Creation path ────────────────────────────────────────────────────────────

  describe('when no resumeId is provided', () => {
    it('creates a new conversation on mount and exposes its id', async () => {
      const { result } = renderHook();
      await tick();

      expect(mocks.createConversation).toHaveBeenCalledOnce();
      expect(mocks.createConversation).toHaveBeenCalledWith(mocks.db, {
        id: FIXED_UUID,
      });
      expect(result.current.conversationId).toBe(FIXED_UUID);
    });

    it('does not call getConversation when no resumeId is passed', async () => {
      renderHook();
      await tick();

      expect(mocks.getConversation).not.toHaveBeenCalled();
    });

    it('starts with an empty messages array', async () => {
      const { result } = renderHook();
      await tick();

      expect(result.current.messages).toEqual([]);
    });
  });

  // ── Resume path ──────────────────────────────────────────────────────────────

  describe('when resumeId is provided and exists in DB', () => {
    const existingMessages = [
      makeMessage('msg-1', RESUME_UUID, 'first'),
      makeMessage('msg-2', RESUME_UUID, 'second'),
    ];

    beforeEach(() => {
      mocks.getConversation.mockReturnValue(makeConversation(RESUME_UUID));
      mocks.getMessages.mockReturnValue(existingMessages);
    });

    it('does not create a new conversation', async () => {
      renderHook(RESUME_UUID);
      await tick();

      expect(mocks.createConversation).not.toHaveBeenCalled();
    });

    it('returns the existing conversation id', async () => {
      const { result } = renderHook(RESUME_UUID);
      await tick();

      expect(result.current.conversationId).toBe(RESUME_UUID);
    });

    it('hydrates messages from the DB in original order', async () => {
      const { result } = renderHook(RESUME_UUID);
      await tick();

      expect(result.current.messages).toEqual(existingMessages);
      expect(mocks.getMessages).toHaveBeenCalledWith(mocks.db, RESUME_UUID);
    });
  });

  // ── Resume fallback ──────────────────────────────────────────────────────────

  describe('when resumeId is provided but not found in DB', () => {
    beforeEach(() => {
      mocks.getConversation.mockReturnValue(undefined);
    });

    it('falls back to creating a new conversation', async () => {
      const { result } = renderHook('nonexistent-id');
      await tick();

      expect(mocks.createConversation).toHaveBeenCalledOnce();
      expect(result.current.conversationId).toBe(FIXED_UUID);
    });

    it('starts with an empty messages array on fallback', async () => {
      const { result } = renderHook('nonexistent-id');
      await tick();

      expect(result.current.messages).toEqual([]);
    });
  });

  // ── addMessage ────────────────────────────────────────────────────────────────

  describe('addMessage', () => {
    it('persists the message to DB via insertMessage with correct fields', async () => {
      const { result } = renderHook();
      await tick();

      result.current.addMessage({ role: 'user', content: 'ping' });
      await tick();

      expect(mocks.insertMessage).toHaveBeenCalledOnce();
      const callArg = mocks.insertMessage.mock.calls[0]?.[1] as Partial<FakeMessage>;
      expect(callArg.conversationId).toBe(FIXED_UUID);
      expect(callArg.content).toBe('ping');
      expect(callArg.role).toBe('user');
    });

    it('appends the returned DB row to local messages state', async () => {
      const insertedMsg = makeMessage('msg-new', FIXED_UUID, 'ping');
      mocks.insertMessage.mockReturnValue(insertedMsg);

      const { result } = renderHook();
      await tick();

      result.current.addMessage({ role: 'user', content: 'ping' });
      await tick();

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0]).toEqual(insertedMsg);
    });

    it('accumulates multiple messages in insertion order', async () => {
      let callCount = 0;
      mocks.insertMessage.mockImplementation(
        (_db: object, data: Partial<FakeMessage>) => {
          callCount++;
          return makeMessage(`msg-${callCount}`, FIXED_UUID, data.content ?? '');
        },
      );

      const { result } = renderHook();
      await tick();

      result.current.addMessage({ role: 'user', content: 'first' });
      result.current.addMessage({ role: 'assistant', content: 'second' });
      await tick();

      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[0]?.content).toBe('first');
      expect(result.current.messages[1]?.content).toBe('second');
    });

    it('returns the persisted Message object from insertMessage', async () => {
      const insertedMsg = makeMessage('msg-ret', FIXED_UUID, 'returned');
      mocks.insertMessage.mockReturnValue(insertedMsg);

      const { result } = renderHook();
      await tick();

      const returned = result.current.addMessage({
        role: 'user',
        content: 'returned',
      });

      expect(returned).toEqual(insertedMsg);
    });

    it('calls touchConversation with the correct conversationId after insert', async () => {
      const { result } = renderHook();
      await tick();

      result.current.addMessage({ role: 'user', content: 'touch me' });
      await tick();

      expect(mocks.touchConversation).toHaveBeenCalledOnce();
      expect(mocks.touchConversation).toHaveBeenCalledWith(mocks.db, FIXED_UUID);
    });

    it('calls touchConversation on every addMessage invocation', async () => {
      const { result } = renderHook();
      await tick();

      result.current.addMessage({ role: 'user', content: 'a' });
      result.current.addMessage({ role: 'user', content: 'b' });
      await tick();

      expect(mocks.touchConversation).toHaveBeenCalledTimes(2);
    });

    it('assigns a new UUID to each message via crypto.randomUUID', async () => {
      cryptoMocks.randomUUID
        .mockReturnValueOnce(FIXED_UUID)    // conversation id
        .mockReturnValueOnce('msg-uuid-1')  // first message
        .mockReturnValueOnce('msg-uuid-2'); // second message

      mocks.insertMessage.mockImplementation(
        (_db: object, data: Partial<FakeMessage>) =>
          makeMessage(data.id ?? 'fallback', FIXED_UUID, data.content ?? ''),
      );

      const { result } = renderHook();
      await tick();

      result.current.addMessage({ role: 'user', content: 'a' });
      result.current.addMessage({ role: 'user', content: 'b' });
      await tick();

      const ids = result.current.messages.map((m) => m.id);
      expect(ids).toEqual(['msg-uuid-1', 'msg-uuid-2']);
    });

    it('is referentially stable across re-renders (useCallback identity)', async () => {
      // Capture addMessage ref before and after a re-render caused by
      // an unrelated state change. The ref should not change because
      // useCallback depends only on [conversationId] which is stable.
      const { result } = renderHook();
      await tick();

      const firstRef = result.current.addMessage;

      // Trigger a re-render by adding a message (setMessages updates state)
      result.current.addMessage({ role: 'user', content: 'trigger rerender' });
      await tick();

      const secondRef = result.current.addMessage;

      expect(firstRef).toBe(secondRef);
    });
  });
});
