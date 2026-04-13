/**
 * MessageListWindowed — non-Static viewport used during scrollback.
 *
 * When the user engages scrollback (scrollOffset > 0 in ChatScreen), the
 * normal <Static> message list is hidden and this component renders a
 * windowed slice of messages inside Ink's dynamic render region.
 *
 * This is deliberately the "slow path":
 *  - No <Static> → re-renders every frame
 *  - Markdown/syntax highlight is skipped for assistant messages so the
 *    slice is cheap to render even on long transcripts
 *  - Streaming is paused at the ChatScreen level while scrolled up, so we
 *    don't pay for re-renders during token flushes
 *
 * The intent is that scrollback is a short-lived "look something up" mode,
 * not a mode you stay in while chatting. When the user scrolls back to the
 * bottom, ChatScreen restores the fast Static path and live streaming.
 */

import { memo } from 'react';
import { Box, Text } from 'ink';
import type { Message } from '@uplnk/db';

interface Props {
  messages: Message[];
  /** Inclusive start index into the full message list. */
  startIdx: number;
  /** Exclusive end index into the full message list. */
  endIdx: number;
}

export const MessageListWindowed = memo(function MessageListWindowed({
  messages,
  startIdx,
  endIdx,
}: Props) {
  const slice = messages.slice(startIdx, endIdx);

  return (
    <Box flexDirection="column">
      {slice.map((message) => {
        const isUser = message.role === 'user';
        const isSystem = message.role === 'system';

        if (isSystem) {
          return (
            <Box key={message.id} marginY={1}>
              <Text color="gray" italic>
                [system] {message.content ?? ''}
              </Text>
            </Box>
          );
        }

        return (
          <Box key={message.id} flexDirection="column" marginY={1}>
            <Box>
              <Text bold color={isUser ? 'white' : '#60A5FA'}>
                {isUser ? '  you  ' : 'uplnk'}
              </Text>
            </Box>
            <Box>
              {!isUser && <Text dimColor>{'│ '}</Text>}
              <Box flexDirection="column" flexShrink={1}>
                <Text wrap="wrap">{message.content ?? ''}</Text>
              </Box>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
});
