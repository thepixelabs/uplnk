import { useState, useCallback } from 'react';
import {
  db,
  createConversation,
  getConversation,
  getMessages,
  insertMessage,
  touchConversation,
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
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, content } : m)),
      );
    },
    [],
  );

  return { conversationId, messages, addMessage, addMessageWithId, updateMessageInState };
}
