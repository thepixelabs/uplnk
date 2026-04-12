import { Box, Static, Text } from 'ink';
import type { Message } from 'uplnk-db';
import { colors } from '../../lib/colors.js';

interface Props {
  messages: Message[];
}

function MessageItem({ message }: { message: Message }) {
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
        <Text bold {...(isUser ? { color: 'white' as const } : {})}>
          {isUser ? colors.user('  you  ') : colors.primary('uplnk')}
        </Text>
      </Box>
      <Box>
        {!isUser && <Text dimColor>{'│ '}</Text>}
        <Text wrap="wrap">{message.content ?? ''}</Text>
      </Box>
    </Box>
  );
}

// <Static> renders items once and never re-renders them — critical for
// performance. Without this, every streaming token re-renders all history.
export function MessageList({ messages }: Props) {
  return (
    <Static items={messages}>
      {(message) => <MessageItem key={message.id} message={message} />}
    </Static>
  );
}
