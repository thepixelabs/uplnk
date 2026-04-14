import { memo } from 'react';
import { Box, Text } from 'ink';
import type { StreamStatus } from '../../hooks/useStream.js';
import { formatTokens } from '../../lib/tokenCounter.js';

interface Props {
  modelName: string;
  conversationTitle: string;
  currentDirectory: string;
  version: string;
  connectionLabel: string;
  connectionDetail: string;
  connectionColor: string;
  messageCount: number;
  status: StreamStatus;
  sessionTokens?: number;
  /** Overrides the status dot label (e.g. "Compacting…") */
  statusOverride?: string | null;
  /** Terminal column count, passed from ChatScreen to avoid double resize subscription */
  columns?: number;
}

const STATUS_DOTS: Record<StreamStatus, string> = {
  idle: '●',
  connecting: '◌',
  waiting: '◌',
  streaming: '▶',
  'tool-running': '⚙',
  done: '●',
  error: '✗',
};

const STATUS_DOT_COLORS: Record<StreamStatus, string> = {
  idle: '#475569',
  connecting: '#FBBF24',
  waiting: '#FBBF24',
  streaming: '#4ADE80',
  'tool-running': '#00D9FF',
  done: '#4ADE80',
  error: '#F87171',
};

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  const keep = maxLength - 1;
  const left = Math.ceil(keep / 2);
  const right = Math.floor(keep / 2);
  return `${value.slice(0, left)}…${value.slice(value.length - right)}`;
}

function compactPath(value: string): string {
  const home = process.env.HOME;
  const withHome = home !== undefined && value.startsWith(home)
    ? `~${value.slice(home.length)}`
    : value;
  return truncateMiddle(withHome, 24);
}

export const Header = memo(function Header({
  modelName,
  conversationTitle,
  currentDirectory,
  version,
  connectionLabel,
  connectionDetail,
  connectionColor,
  messageCount,
  status,
  sessionTokens,
  statusOverride,
  columns = 80,
}: Props) {

  const statusDot = STATUS_DOTS[status];
  const statusDotColor = statusOverride != null ? '#FBBF24' : STATUS_DOT_COLORS[status];
  const statusDisplay = statusOverride ?? statusDot;

  const tokenStr = sessionTokens !== undefined && sessionTokens > 0
    ? `◆ ${formatTokens(sessionTokens)}`
    : '';

  return (
    <Box
      borderStyle="single"
      borderColor="#374151"
      paddingX={1}
      width={columns > 0 ? columns : undefined}
      flexShrink={0}
      flexDirection="row"
    >
      <Box borderStyle="single" borderColor="#374151" paddingX={1} marginRight={1} flexDirection="column" minWidth={30}>
        <Text>
          <Text color="#60A5FA">▐</Text>
          <Text color="#60A5FA" bold>█</Text>
          <Text color="#60A5FA">▌</Text>
          <Text bold> UPLNK</Text>
          <Text dimColor>{`  v${version}`}</Text>
        </Text>
        <Box justifyContent="space-between">
          <Text color="#6B7280">{`cwd ${compactPath(currentDirectory)}`}</Text>
          <Text dimColor>{`${String(messageCount)} msgs`}</Text>
        </Box>
      </Box>

      <Box flexGrow={1} flexDirection="column" justifyContent="center" minWidth={12}>
        <Text bold>{truncateMiddle(conversationTitle, 24)}</Text>
        <Box>
          <Text color={statusDotColor}>{statusDisplay} </Text>
          <Text color="#00D9FF">{truncateMiddle(modelName, 22)}</Text>
        </Box>
      </Box>

      <Box borderStyle="single" borderColor={connectionColor} paddingX={1} marginLeft={1} flexDirection="column" minWidth={28}>
        <Text color={connectionColor}>{truncateMiddle(connectionLabel, 26)}</Text>
        <Box justifyContent="space-between">
          <Text dimColor>{truncateMiddle(connectionDetail, 18)}</Text>
          {tokenStr.length > 0 && <Text color="#475569">{tokenStr}</Text>}
        </Box>
      </Box>
    </Box>
  );
});
