// packages/app/src/components/chat/MessageItem.tsx
import { memo } from 'react';
import { Box, Text } from 'ink';
import type { Message } from '@uplnk/db';
import { MarkdownMessage } from './MarkdownMessage.js';
import type { Artifact } from '../artifacts/ArtifactPanel.js';

interface MessageItemProps {
  message: Message;
  onPromote?: (artifact: Artifact) => void;
  displayName?: string;
}

// MessageItem is frozen after first render when inside <Static>.
// Keep it pure: no useState, no useEffect, no dynamic imports.
export const MessageItem = memo(function MessageItem({ message, onPromote, displayName }: MessageItemProps) {
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
          {isUser ? `  ${displayName ?? 'you'}  ` : 'uplnk'}
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
