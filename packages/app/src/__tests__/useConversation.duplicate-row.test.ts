/**
 * useConversation — duplicate-row regression tests (H2).
 *
 * Background
 * ──────────
 * Prior to the C1 incremental persistence refactor, ChatScreen inserted an
 * assistant row at stream end via addMessage(). After the refactor, the DB
 * row is pre-inserted at stream start (addMessageWithId) and its content is
 * mutated in place by the persistence worker — the final-flush step only needs
 * to update React state via updateMessageInState(). A regression would re-add
 * a second insertMessage() call at stream end and silently produce duplicate
 * assistant rows in SQLite.
 *
 * These tests pin the hook-level contract that the ChatScreen stream handler
 * depends on:
 *   1. addMessageWithId persists ONE row and reflects it in state.
 *   2. updateMessageInState mutates state only — NEVER writes to the DB.
 *   3. A full stream-completion sequence (addMessageWithId → updateMessageInState)
 *      results in exactly one assistant row having been inserted.
 *
 * If any of these contracts breaks, the H2 duplicate-row bug returns.
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

vi.mock('@uplnk/db', () => ({
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CONV_UUID = 'cccccccc-0000-0000-0000-000000000001';
const ASSISTANT_MSG_ID = 'dddddddd-0000-0000-0000-000000000002';

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

function makeMessage(
  id: string,
  conversationId: string,
  role: FakeMessage['role'],
  content: string | null,
): FakeMessage {
  return {
    id,
    conversationId,
    role,
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

function renderHook(): {
  result: { current: UseConversationResult };
  unmount: () => void;
} {
  const result: { current: UseConversationResult } = {
    current: undefined as unknown as UseConversationResult,
  };

  function HookWrapper() {
    result.current = useConversation();
    return React.createElement(React.Fragment, null);
  }

  const { unmount } = render(React.createElement(HookWrapper));
  return { result, unmount };
}

const tick = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useConversation — duplicate-row regression (H2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cryptoMocks.randomUUID.mockReturnValue(CONV_UUID);
    mocks.createConversation.mockImplementation(
      (_db: object, data: { id: string }) => ({
        id: data.id,
        title: 'New conversation',
        providerId: null,
        modelId: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        deletedAt: null,
      }),
    );
    mocks.getConversation.mockReturnValue(undefined);
    mocks.getMessages.mockReturnValue([]);
    mocks.insertMessage.mockImplementation(
      (_db: object, data: Partial<FakeMessage>) =>
        makeMessage(
          data.id ?? 'fallback-id',
          data.conversationId ?? CONV_UUID,
          data.role ?? 'assistant',
          data.content ?? null,
        ),
    );
  });

  // ── addMessageWithId ────────────────────────────────────────────────────────

  describe('addMessageWithId', () => {
    it('persists exactly one row per call with the caller-supplied id', async () => {
      const { result } = renderHook();
      await tick();

      result.current.addMessageWithId({
        id: ASSISTANT_MSG_ID,
        role: 'assistant',
        content: '',
      });
      await tick();

      expect(mocks.insertMessage).toHaveBeenCalledOnce();
      const callArg = mocks.insertMessage.mock.calls[0]?.[1] as Partial<FakeMessage>;
      expect(callArg.id).toBe(ASSISTANT_MSG_ID);
      expect(callArg.role).toBe('assistant');
      expect(callArg.conversationId).toBe(CONV_UUID);
    });

    it('appends the row to local state exactly once', async () => {
      const { result } = renderHook();
      await tick();

      result.current.addMessageWithId({
        id: ASSISTANT_MSG_ID,
        role: 'assistant',
        content: '',
      });
      await tick();

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0]?.id).toBe(ASSISTANT_MSG_ID);
    });
  });

  // ── updateMessageInState ───────────────────────────────────────────────────

  describe('updateMessageInState', () => {
    it('does NOT call insertMessage (state-only, no DB write)', async () => {
      const { result } = renderHook();
      await tick();

      // Seed a pre-existing assistant row (simulates the C1 pre-insert).
      result.current.addMessageWithId({
        id: ASSISTANT_MSG_ID,
        role: 'assistant',
        content: '',
      });
      await tick();

      mocks.insertMessage.mockClear();

      result.current.updateMessageInState(ASSISTANT_MSG_ID, 'final text');
      await tick();

      // The critical H2 assertion: no second insert.
      expect(mocks.insertMessage).not.toHaveBeenCalled();
    });

    it('updates the matching row in state without touching others', async () => {
      const { result } = renderHook();
      await tick();

      result.current.addMessageWithId({
        id: ASSISTANT_MSG_ID,
        role: 'assistant',
        content: 'partial',
      });
      await tick();

      result.current.updateMessageInState(ASSISTANT_MSG_ID, 'final text');
      await tick();

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0]?.content).toBe('final text');
    });

    it('is a no-op when the id does not match any message in state', async () => {
      const { result } = renderHook();
      await tick();

      result.current.addMessageWithId({
        id: ASSISTANT_MSG_ID,
        role: 'assistant',
        content: 'kept',
      });
      await tick();

      result.current.updateMessageInState('non-existent-id', 'ignored');
      await tick();

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0]?.content).toBe('kept');
      expect(mocks.insertMessage).toHaveBeenCalledTimes(1); // only the seed insert
    });
  });

  // ── End-to-end stream-completion sequence ─────────────────────────────────

  describe('full stream completion sequence (addMessageWithId then updateMessageInState)', () => {
    it('results in exactly ONE assistant row inserted, preserving final content', async () => {
      // This test mirrors the ChatScreen stream lifecycle:
      //   1. At stream START the handler pre-inserts an empty assistant row.
      //   2. A background worker persists partial content directly to the DB
      //      (simulated here by a second insertMessage — NOT the hook's doing).
      //   3. At stream END the handler flushes final text into React state
      //      via updateMessageInState — which must NOT re-insert.
      //
      // The regression we guard against: step 3 being implemented with
      // addMessage() instead of updateMessageInState(), producing a duplicate
      // row.

      const { result } = renderHook();
      await tick();

      // Step 1 — pre-insert at stream start
      result.current.addMessageWithId({
        id: ASSISTANT_MSG_ID,
        role: 'assistant',
        content: '',
      });
      await tick();

      // Step 3 — final-flush at stream end
      result.current.updateMessageInState(
        ASSISTANT_MSG_ID,
        'The complete streamed response.',
      );
      await tick();

      // Exactly one row inserted through the hook.
      expect(mocks.insertMessage).toHaveBeenCalledOnce();
      // Final content is visible in state.
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0]?.id).toBe(ASSISTANT_MSG_ID);
      expect(result.current.messages[0]?.content).toBe(
        'The complete streamed response.',
      );
    });

    it('partial content persisted mid-stream is preserved when final flush updates state', async () => {
      // Simulates: partial chunk arrives, updateMessageInState commits it,
      // more chunks arrive, final flush commits the full text. None of this
      // should trigger extra inserts through the hook.
      const { result } = renderHook();
      await tick();

      result.current.addMessageWithId({
        id: ASSISTANT_MSG_ID,
        role: 'assistant',
        content: '',
      });
      await tick();

      result.current.updateMessageInState(ASSISTANT_MSG_ID, 'Hello');
      await tick();
      expect(result.current.messages[0]?.content).toBe('Hello');

      result.current.updateMessageInState(ASSISTANT_MSG_ID, 'Hello, world');
      await tick();
      expect(result.current.messages[0]?.content).toBe('Hello, world');

      result.current.updateMessageInState(ASSISTANT_MSG_ID, 'Hello, world!');
      await tick();
      expect(result.current.messages[0]?.content).toBe('Hello, world!');

      // Still exactly one DB insert through the hook — all intermediate
      // updates were state-only.
      expect(mocks.insertMessage).toHaveBeenCalledOnce();
    });
  });
});
