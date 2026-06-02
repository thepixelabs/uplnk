import { memo } from 'react';
import { Box, Text } from 'ink';
import type { StreamStatus, LastTurnStats, LiveTurnTokens } from '../../hooks/useStream.js';
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
  /** Per-turn stats from the most recently completed stream. Rendered only when `showStats` is true. */
  lastTurnStats?: LastTurnStats | null;
  /** Live in/out tokens for the currently streaming turn. Rendered during stream/tool-running. */
  liveTurnTokens?: LiveTurnTokens | null;
  /** Toggles the bottom stats row in the right-hand connection box. */
  showStats?: boolean;
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

function formatTokensPerSecond(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  return value >= 100 ? `${Math.round(value)}` : value.toFixed(1);
}

function formatTtft(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
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
  lastTurnStats,
  liveTurnTokens,
  showStats = false,
}: Props) {

  const statusDot = STATUS_DOTS[status];
  const statusDotColor = statusOverride != null ? '#FBBF24' : STATUS_DOT_COLORS[status];
  const statusDisplay = statusOverride ?? statusDot;

  const tokenStr = sessionTokens !== undefined && sessionTokens > 0
    ? `◆ ${formatTokens(sessionTokens)}`
    : '';

  const haveStats = lastTurnStats !== undefined && lastTurnStats !== null;
  const isStreaming = status === 'streaming' || status === 'tool-running' || status === 'connecting' || status === 'waiting';
  const haveLive =
    liveTurnTokens !== undefined &&
    liveTurnTokens !== null &&
    (liveTurnTokens.input > 0 || liveTurnTokens.output > 0);
  // While streaming, prefer the live counter so the user sees tokens
  // accrue in real time. After the turn ends, fall back to the per-turn
  // summary with tok/s + TTFT.
  const statsRow = (() => {
    if (!showStats) return '';
    if (isStreaming && haveLive) {
      return `↑${formatTokens(liveTurnTokens.input)} ↓${formatTokens(liveTurnTokens.output)} · streaming…`;
    }
    if (haveStats) {
      return `↑${formatTokens(lastTurnStats.promptTokens)} ↓${formatTokens(lastTurnStats.completionTokens)} · ${formatTokensPerSecond(lastTurnStats.tokensPerSecond)} tok/s · TTFT ${formatTtft(lastTurnStats.ttftMs)}`;
    }
    return '';
  })();

  return (
    <Box
      borderStyle="single"
      borderColor="#374151"
      paddingX={1}
      width={columns > 0 ? columns : undefined}
      flexShrink={0}
      flexDirection="column"
    >
      <Box flexDirection="row">
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

      {showStats && statsRow.length > 0 && (
        <Box paddingX={1}>
          <Text color="#94A3B8">{statsRow}</Text>
        </Box>
      )}
    </Box>
  );
});
