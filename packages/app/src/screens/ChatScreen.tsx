import { useState, useCallback, useEffect, useRef } from 'react';
import { Box, useInput } from 'ink';
import type { CoreMessage } from 'ai';
import { useStream } from '../hooks/useStream.js';
import { MessageList } from '../components/chat/MessageList.js';
import { StreamingMessage } from '../components/chat/StreamingMessage.js';
import { ChatInput } from '../components/chat/ChatInput.js';
import { Header } from '../components/layout/Header.js';
import { StatusBar } from '../components/layout/StatusBar.js';
import type { UplnkError } from 'uplnk-shared';
import type { Message } from 'uplnk-db';

// Minimal provider setup — replaced by full config system in v0.2
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

interface Props {
  initialModel?: string;
  onNavigate?: (screen: string) => void;
  onError: (error: UplnkError) => void;
}

function createDefaultModel(modelName: string) {
  const provider = createOpenAICompatible({
    name: 'ollama',
    baseURL: 'http://localhost:11434/v1',
    apiKey: 'ollama',
  });
  return provider(modelName);
}

export function ChatScreen({ initialModel = 'llama3.2', onError }: Props) {
  const [persistedMessages, setPersistedMessages] = useState<Message[]>([]);
  const activeModel = createDefaultModel(initialModel);
  const { streamedText, status, error, send, abort } = useStream(activeModel);
  const prevStatusRef = useRef(status);

  // When streaming finishes, promote the streamed text to a persisted message
  useEffect(() => {
    if (prevStatusRef.current === 'streaming' && status === 'done' && streamedText) {
      setPersistedMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          conversationId: 'local',
          role: 'assistant',
          content: streamedText,
          toolCalls: null,
          toolCallId: null,
          inputTokens: null,
          outputTokens: null,
          timeToFirstToken: null,
          createdAt: new Date().toISOString(),
        } satisfies Message,
      ]);
    }
    prevStatusRef.current = status;
  }, [status, streamedText]);

  useEffect(() => {
    if (error) onError(error);
  }, [error, onError]);

  const handleSubmit = useCallback(
    async (input: string) => {
      if (!input.trim() || status === 'streaming') return;

      const userMessage: Message = {
        id: crypto.randomUUID(),
        conversationId: 'local',
        role: 'user',
        content: input,
        toolCalls: null,
        toolCallId: null,
        inputTokens: null,
        outputTokens: null,
        timeToFirstToken: null,
        createdAt: new Date().toISOString(),
      };

      setPersistedMessages((prev) => [...prev, userMessage]);

      // Build typed CoreMessage array for the AI SDK
      const coreMessages: CoreMessage[] = [
        ...persistedMessages
          .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
          .map((m): CoreMessage => {
            if (m.role === 'assistant') return { role: 'assistant', content: m.content ?? '' };
            if (m.role === 'system') return { role: 'system', content: m.content ?? '' };
            return { role: 'user', content: m.content ?? '' };
          }),
        { role: 'user', content: input },
      ];

      await send(coreMessages);
    },
    [persistedMessages, status, send],
  );

  useInput((input, key) => {
    if (key.ctrl && input === 'c' && status === 'streaming') {
      abort();
    }
  });

  return (
    <Box flexDirection="column" height="100%">
      <Header
        modelName={initialModel}
        conversationTitle="New conversation"
      />
      <Box flexDirection="column" flexGrow={1}>
        <MessageList messages={persistedMessages} />
        <StreamingMessage text={streamedText} status={status} />
      </Box>
      <StatusBar status={status} messageCount={persistedMessages.length} />
      <ChatInput onSubmit={handleSubmit} disabled={status === 'streaming'} />
    </Box>
  );
}
