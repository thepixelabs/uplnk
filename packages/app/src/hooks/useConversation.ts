import { useState, useCallback } from 'react';
import {
  db,
  createConversation,
  getConversation,
  getMessages,
  insertMessage,
  touchConversation,
  deleteMessage,
} from '@uplnk/db';
import type { Message, NewMessage } from '@uplnk/db';

export type AddMessageData = Omit<NewMessage, 'id' | 'conversationId' | 'createdAt'>;
export type AddMessageWithIdData = Omit<NewMessage, 'conversationId' | 'createdAt'>;

export interface UseConversationResult {
  conversationId: string;
  messages: Message[];
  addMessage: (data: AddMessageData) => Message;
  /**
   * Insert a message with a caller-supplied id. Used in the C1 incremental
   * persistence flow where the caller needs the id before the row is committed
   * (to pass to updateMessageContent). Returns the inserted Message.
   */
  addMessageWithId: (data: AddMessageWithIdData) => Message;
  /**
   * Update an existing message in React state without writing to SQLite.
   * Used after C1 incremental persistence: the DB row is already up-to-date;
   * we only need to reflect the final content in the component tree.
   */
  updateMessageInState: (id: string, content: string) => void;
  /**
   * Append a fully-formed assistant message to React state without writing
   * to SQLite. Used by the C1 incremental persistence flow: the DB row was
   * pre-inserted at stream start and kept in sync via updateMessageContent,
   * so at stream end we only need to reflect it in the component tree — a
   * second insertMessage call would create a duplicate row.
   */
  appendAssistantToState: (id: string, content: string) => void;
  /**
   * Replace a contiguous prefix of messages with a single synthetic summary
   * message. Used by the /compact flow: the caller decides which messages to
   * drop (typically "all except the last N"), generates a summary, then calls
   * this to atomically rewrite both SQLite and React state.
   *
   * `idsToRemove` must be a list of message ids that currently exist in state.
   * The new synthetic message is inserted with `summaryContent` and role
   * `system`, so the LLM sees it as authoritative context on the next turn.
   */
  replaceWithSummary: (idsToRemove: string[], summaryContent: string) => Message;
}

export function useConversation(resumeId?: string): UseConversationResult {
  // Synchronous init via lazy useState — safe because runMigrations() ran before render()
  const [conversationId] = useState<string>(() => {
    if (resumeId !== undefined) {
      const conv = getConversation(db, resumeId);
      if (conv !== undefined) return conv.id;
    }
    return createConversation(db, { id: crypto.randomUUID() }).id;
  });

  const [messages, setMessages] = useState<Message[]>(() => {
    if (resumeId !== undefined) {
      const conv = getConversation(db, resumeId);
      if (conv !== undefined) return getMessages(db, conv.id);
    }
    return [];
  });

  const addMessage = useCallback(
    (data: AddMessageData): Message => {
      const newMsg = insertMessage(db, {
        ...data,
        id: crypto.randomUUID(),
        conversationId,
      });
      setMessages((prev) => [...prev, newMsg]);
      touchConversation(db, conversationId);
      return newMsg;
    },
    [conversationId],
  );

  const addMessageWithId = useCallback(
    (data: AddMessageWithIdData): Message => {
      const newMsg = insertMessage(db, {
        ...data,
        conversationId,
      });
      setMessages((prev) => [...prev, newMsg]);
      touchConversation(db, conversationId);
      return newMsg;
    },
    [conversationId],
  );

  const updateMessageInState = useCallback(
    (id: string, content: string): void => {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === id);
        // Message not yet in state (e.g. pre-inserted to DB but not state yet) —
        // return the same reference so React skips the re-render entirely.
        if (idx === -1) return prev;
        if (prev[idx]!.content === content) return prev;
        const next = [...prev];
        next[idx] = { ...prev[idx]!, content };
        return next;
      });
    },
    [],
  );

  const appendAssistantToState = useCallback(
    (id: string, content: string): void => {
      setMessages((prev) => {
        // Idempotent: if the id is already in state, just update its content.
        // This protects against a double-effect fire in React StrictMode.
        if (prev.some((m) => m.id === id)) {
          return prev.map((m) => (m.id === id ? { ...m, content } : m));
        }
        const now = new Date().toISOString();
        const msg: Message = {
          id,
          conversationId,
          role: 'assistant',
          content,
          toolCalls: null,
          toolCallId: null,
          inputTokens: null,
          outputTokens: null,
          timeToFirstToken: null,
          createdAt: now,
        };
        return [...prev, msg];
      });
      // DB row was already written by the streaming persist callback;
      // we only need to bump the conversation's updated_at.
      touchConversation(db, conversationId);
    },
    [conversationId],
  );

  const replaceWithSummary = useCallback(
    (idsToRemove: string[], summaryContent: string): Message => {
      // Insert the synthetic summary first so there's always at least one
      // message in the conversation even if a delete fails mid-loop.
      const summaryMsg = insertMessage(db, {
        id: crypto.randomUUID(),
        conversationId,
        role: 'system',
        content: summaryContent,
      });
      for (const id of idsToRemove) {
        deleteMessage(db, id);
      }
      const removeSet = new Set(idsToRemove);
      setMessages((prev) => {
        const kept = prev.filter((m) => !removeSet.has(m.id));
        // Place the summary at the front so it acts as a prefix to whatever
        // tail survived the compaction.
        return [summaryMsg, ...kept];
      });
      touchConversation(db, conversationId);
      return summaryMsg;
    },
    [conversationId],
  );

  return {
    conversationId,
    messages,
    addMessage,
    addMessageWithId,
    updateMessageInState,
    appendAssistantToState,
    replaceWithSummary,
  };
}
