import { memo } from 'react';
import { Box, Text } from 'ink';
import type { StreamStatus } from '../../hooks/useStream.js';
import { formatTokens, renderGaugeBar } from '../../lib/tokenCounter.js';

interface Props {
  status: StreamStatus;
  messageCount: number;
  /** Name of the currently executing tool (only present when status is 'tool-running') */
  activeToolName?: string | null;
  /**
   * Cumulative token count for the current session, as reported by the model's
   * `usage.totalTokens` across all completed steps. Rendered as a compact
   * label (e.g. "1.2k") next to the status indicator. When 0 or undefined the
   * gauge slot renders empty so the bar layout stays stable on first paint.
   */
  sessionTokens?: number;
  /**
   * Context window size for the active model. When provided, the token label
   * is accompanied by a small fill bar showing how close the session is to
   * the wall. Optional because not every caller has this wired up yet.
   */
  contextWindow?: number;
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

/** Pick a color for the gauge based on how full the context window is. */
function gaugeColor(used: number, total: number | undefined): string {
  if (total === undefined || total <= 0) return 'gray';
  const ratio = used / total;
  if (ratio >= 0.9) return 'red';
  if (ratio >= 0.7) return 'yellow';
  return 'cyan';
}

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
 *
 * Token gauge (2026-04-13): a middle slot renders the session token count,
 * also inside a fixed minWidth Box so its changing width (e.g. "812" → "1.2k")
 * doesn't shift the right-hand hint text either.
 */
export const StatusBar = memo(function StatusBar({
  status,
  messageCount,
  activeToolName,
  sessionTokens,
  contextWindow,
}: Props) {
  const label =
    status === 'tool-running' && activeToolName != null && activeToolName.length > 0
      ? `⚙ running tool: ${activeToolName}`
      : STATUS_LABELS[status];

  const showGauge = typeof sessionTokens === 'number' && sessionTokens > 0;
  const hasContext = typeof contextWindow === 'number' && contextWindow > 0;
  const gaugeText = showGauge
    ? hasContext
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      ? `◆ ${formatTokens(sessionTokens)} ${renderGaugeBar(sessionTokens, contextWindow!, 8)} ${Math.round((sessionTokens / contextWindow!) * 100)}%`
      : `◆ ${formatTokens(sessionTokens)} tok`
    : '';
  const gaugeColorValue = gaugeColor(sessionTokens ?? 0, contextWindow);

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
      {/* Token gauge — also fixed-width so it never shifts the hint */}
      <Box minWidth={26}>
        {gaugeText.length > 0 ? <Text color={gaugeColorValue}>{gaugeText}</Text> : null}
      </Box>
      <Text dimColor>{messageCount} messages  Ctrl+C quit  Ctrl+L conversations</Text>
    </Box>
  );
});
