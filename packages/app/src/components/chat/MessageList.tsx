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
  cursorIndex?: number;
}

export const MessageList = memo(function MessageList({
  messages,
  startIdx,
  endIdx,
  onPromote,
  displayName,
  cursorIndex,
}: MessageListProps) {
  const slice = messages.slice(startIdx, endIdx);

  if (slice.length === 0) {
    return <Box />;
  }

  return (
    <Box flexDirection="column">
      {slice.map((message, sliceOffset) => {
        const absoluteIdx = startIdx + sliceOffset;
        return (
          <MessageComponent
            key={message.id}
            message={message}
            isUser={message.role === 'user'}
            isSystem={message.role === 'system'}
            isCursorTarget={cursorIndex === absoluteIdx}
            index={absoluteIdx + 1}
            {...(onPromote !== undefined ? { onPromote } : {})}
            {...(displayName !== undefined ? { displayName } : {})}
          />
        );
      })}
    </Box>
  );
});
