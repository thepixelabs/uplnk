import { memo } from 'react';
import { Box } from 'ink';
import type { Message } from '@uplnk/db';
import type { Artifact } from '../artifacts/ArtifactPanel.js';
import { MessageComponent } from './MessageComponent.js';

interface MessageListProps {
  messages: Message[];
  startIdx: number;
  endIdx: number;
  onPromote?: (artifact: Artifact) => void;
  displayName?: string;
}

export const MessageList = memo(function MessageList({
  messages,
  startIdx,
  endIdx,
  onPromote,
  displayName,
}: MessageListProps) {
  const slice = messages.slice(startIdx, endIdx);

  if (slice.length === 0) {
    return <Box />;
  }

  return (
    <Box flexDirection="column">
      {slice.map((message) => (
        <MessageComponent
          key={message.id}
          message={message}
          {...(onPromote !== undefined ? { onPromote } : {})}
          isUser={message.role === 'user'}
          isSystem={message.role === 'system'}
          {...(displayName !== undefined ? { displayName } : {})}
        />
      ))}
    </Box>
  );
});
