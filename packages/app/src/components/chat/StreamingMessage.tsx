import { Box, Text } from 'ink';
import type { StreamStatus } from '../../hooks/useStream.js';
import { colors } from '../../lib/colors.js';

interface Props {
  text: string;
  status: StreamStatus;
}

export function StreamingMessage({ text, status }: Props) {
  if (status === 'connecting') {
    return (
      <Box marginY={1}>
        <Text color="gray">{'  '}thinking…</Text>
      </Box>
    );
  }

  if (status === 'idle' || (status === 'done' && !text)) {
    return null;
  }

  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text color={colors.primaryDim('│')} dimColor>{'│ '}</Text>
        <Text>
          {text}
          {status === 'streaming' && (
            <Text backgroundColor={colors.cursorBg}> </Text>
          )}
        </Text>
      </Box>
    </Box>
  );
}
