import { memo } from 'react';
import { Box, Text } from 'ink';
import type { Message } from '@uplnk/db';
import { MarkdownMessage } from './MarkdownMessage.js';
import type { Artifact } from '../artifacts/ArtifactPanel.js';

interface MessageComponentProps {
  message: Message;
  onPromote?: (artifact: Artifact) => void;
  isUser: boolean;
  isSystem: boolean;
  displayName?: string;
}

export const MessageComponent = memo(function MessageComponent({
  message,
  onPromote,
  isUser,
  isSystem,
  displayName,
}: MessageComponentProps) {
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
