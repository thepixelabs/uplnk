import { Box, Text } from 'ink';
import type { StreamStatus } from '../../hooks/useStream.js';

interface Props {
  status: StreamStatus;
  messageCount: number;
}

const STATUS_LABELS: Record<StreamStatus, string> = {
  idle: '●',
  connecting: '○ connecting…',
  streaming: '▶ streaming',
  done: '✓',
  error: '✗ error',
};

const STATUS_COLORS: Record<StreamStatus, string> = {
  idle: 'gray',
  connecting: 'yellow',
  streaming: 'green',
  done: 'green',
  error: 'red',
};

export function StatusBar({ status, messageCount }: Props) {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text color={STATUS_COLORS[status]}>{STATUS_LABELS[status]}</Text>
      <Text dimColor>{messageCount} messages  Ctrl+C quit  Ctrl+L conversations</Text>
    </Box>
  );
}
