/**
 * MessageList — renders committed (non-streaming) chat messages.
 *
 * PERFORMANCE CRITICAL: Uses Ink's <Static> component for committed messages.
 * <Static> renders children once and never re-diffs them, which is mandatory
 * for streaming performance: without it, each ~33ms token flush triggers Ink to
 * re-reconcile the entire message history (O(n) per flush at 30fps = O(n*30) per second).
 *
 * Architecture reference: chatty/reports/02-cto-tech-strategy-v2.md §2.4
 * "Use Ink's <Static> for the committed message list. Never put mutable state
 *  in the items rendered by <Static> — it won't re-render."
 *
 * Consequences:
 * - MessageItem props are frozen at render time — do not pass mutable state
 * - onPromote must be a stable callback (wrapped in useCallback at call site)
 * - Artifact promotion works because it updates ArtifactPanel state (outside Static)
 */

import { memo } from 'react';
import { Box, Text, Static } from 'ink';
import type { Message } from 'pylon-db';
import { MarkdownMessage } from './MarkdownMessage.js';
import type { Artifact } from '../artifacts/ArtifactPanel.js';

interface Props {
  messages: Message[];
  onPromote?: (artifact: Artifact) => void;
}

interface MessageItemProps {
  message: Message;
  onPromote?: (artifact: Artifact) => void;
}

// MessageItem is frozen after first render when inside <Static>.
// Keep it pure: no useState, no useEffect, no dynamic imports.
const MessageItem = memo(function MessageItem({ message, onPromote }: MessageItemProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  if (isSystem) {
    return (
      <Box marginY={1}>
        <Text color="gray" italic>[system] {message.content ?? ''}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text bold color={isUser ? 'white' : '#60A5FA'}>
          {isUser ? '  you  ' : 'pylon'}
        </Text>
      </Box>
      <Box>
        {!isUser && <Text dimColor>{'│ '}</Text>}
        <Box flexDirection="column" flexShrink={1}>
          {isUser ? (
            <Text wrap="wrap">{message.content ?? ''}</Text>
          ) : (
            <MarkdownMessage
              text={message.content ?? ''}
              messageId={message.id}
              {...(onPromote !== undefined ? { onPromote } : {})}
            />
          )}
        </Box>
      </Box>
    </Box>
  );
});

/**
 * MessageList wraps committed messages in <Static> so Ink's reconciler
 * never re-diffs them. New messages are appended (Static grows downward);
 * existing messages are frozen.
 *
 * If messages is empty, <Static> renders nothing and leaves no phantom whitespace.
 */
export const MessageList = memo(function MessageList({ messages, onPromote }: Props) {
  if (messages.length === 0) {
    return <Box />;
  }

  return (
    <Static items={messages}>
      {(message) => (
        <MessageItem
          key={message.id}
          message={message}
          {...(onPromote !== undefined ? { onPromote } : {})}
        />
      )}
    </Static>
  );
});
