import { memo } from 'react';
import { Box, Text } from 'ink';
import type { StreamStatus } from '../../hooks/useStream.js';

interface Props {
  status: StreamStatus;
  messageCount: number;
  /** Name of the currently executing tool (only present when status is 'tool-running') */
  activeToolName?: string | null;
}

const STATUS_LABELS: Record<StreamStatus, string> = {
  idle: '●',
  connecting: '○ connecting…',
  waiting: '◌ waiting for model…',
  streaming: '▶ streaming',
  'tool-running': '⚙ running tool',
  done: '✓',
  error: '✗ error',
};

const STATUS_COLORS: Record<StreamStatus, string> = {
  idle: 'gray',
  connecting: 'yellow',
  waiting: 'yellow',
  streaming: 'green',
  'tool-running': 'cyan',
  done: 'green',
  error: 'red',
};

/**
 * StatusBar — pinned to the bottom of the chat column, above ChatInput.
 *
 * Layout stability fix (2026-04-12): The bar previously re-flowed its
 * neighbours during streaming because the status label changes width
 * ("●" vs "▶ streaming" vs "⚙ running tool: bash") and Ink re-measured
 * the whole flex column on each tick.
 *
 * Two fixes applied:
 *   1. `flexShrink={0}` — prevents the bar from being squeezed when the
 *      terminal fills with messages during a long stream.
 *   2. Fixed-width left cell via `minWidth` — the label Text is wrapped in a
 *      Box with a minWidth wide enough to hold the longest expected label,
 *      so the right-side hint text never shifts horizontally between ticks.
 */
export const StatusBar = memo(function StatusBar({ status, messageCount, activeToolName }: Props) {
  const label =
    status === 'tool-running' && activeToolName != null && activeToolName.length > 0
      ? `⚙ running tool: ${activeToolName}`
      : STATUS_LABELS[status];

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      justifyContent="space-between"
      flexShrink={0}
    >
      {/* Fixed-width slot so label length changes never shift the hint text */}
      <Box minWidth={28}>
        <Text color={STATUS_COLORS[status]}>{label}</Text>
      </Box>
      <Text dimColor>{messageCount} messages  Ctrl+C quit  Ctrl+L conversations</Text>
    </Box>
  );
});
