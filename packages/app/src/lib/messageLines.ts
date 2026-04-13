/**
 * messageLines — estimate how many terminal rows a rendered chat message
 * occupies, given the content column width.
 *
 * Used by the scrollback viewport in ChatScreen to decide which messages
 * fit into a fixed-height window and how many lines a "scroll by one
 * message" jump should advance.
 *
 * The numbers here are an approximation — we deliberately do not try to
 * reproduce Ink's exact wrap logic (markdown, ANSI sequences, emoji width,
 * code blocks with syntax highlight). A few lines of drift per message is
 * fine: the worst case is a slightly larger or smaller viewport than
 * expected, never a crash or lost content.
 *
 * Assumptions matching MessageList.tsx:
 * - system messages render on 1 line (with marginY=1 → +2 blank rows)
 * - user/assistant messages render:
 *     - 1 row for the role label
 *     - wrapped content rows (assistant has a "│ " gutter → -2 cols)
 *     - marginY=1 → +2 blank rows
 */

import type { Message } from '@uplnk/db';

/** Minimum effective content width — guards against absurdly narrow terminals. */
const MIN_CONTENT_COLS = 10;

export interface MessageLineInfo {
  /** Index of the message in the source array. */
  index: number;
  /** Terminal rows the message occupies at the given content width. */
  lines: number;
  /** Cumulative lines of all messages with index <= this one. */
  cumulative: number;
}

/**
 * Count wrapped lines for a block of text at a given column width. Treats
 * embedded "\n" as hard breaks; empty lines still count as one row.
 */
export function countWrappedLines(text: string, cols: number): number {
  const effCols = Math.max(MIN_CONTENT_COLS, cols);
  if (text === '') return 1;
  let total = 0;
  for (const line of text.split('\n')) {
    if (line.length === 0) {
      total += 1;
      continue;
    }
    total += Math.ceil(line.length / effCols);
  }
  return total;
}

/**
 * Estimate the rendered line count for a single message.
 *
 * @param message  The Message (user/assistant/system)
 * @param cols     Content width in columns (already adjusted for split pane)
 */
export function estimateMessageLines(message: Message, cols: number): number {
  const content = message.content ?? '';
  if (message.role === 'system') {
    // [system] <content> on one wrap group + marginY=1 (2 blank lines).
    return countWrappedLines(`[system] ${content}`, cols) + 2;
  }
  // user/assistant: 1 label row + wrapped content + marginY=1 (2 blank lines).
  // Assistant messages have a "│ " gutter that consumes 2 cols.
  const gutter = message.role === 'assistant' ? 2 : 0;
  const contentCols = Math.max(MIN_CONTENT_COLS, cols - gutter);
  return 1 + countWrappedLines(content, contentCols) + 2;
}

/**
 * Build a running tally of per-message line counts. The result is indexed
 * the same as the input, so callers can binary-search or walk to compute a
 * viewport window.
 */
export function buildLineIndex(messages: Message[], cols: number): MessageLineInfo[] {
  const out: MessageLineInfo[] = [];
  let cumulative = 0;
  for (let i = 0; i < messages.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const lines = estimateMessageLines(messages[i]!, cols);
    cumulative += lines;
    out.push({ index: i, lines, cumulative });
  }
  return out;
}

/**
 * Given a line index and a line budget, return the slice of messages that
 * should be visible in the viewport.
 *
 * `topLine` is measured from the TOP of the full message list (line 0 is
 * the first line of the first message). The window is inclusive: we start
 * at the first message whose last line is >= topLine, and walk forward
 * while the cumulative content fits within `maxLines`.
 *
 * Returns start/end indices into `messages` (end is exclusive).
 */
export function windowByLineOffset(
  lineIndex: MessageLineInfo[],
  topLine: number,
  maxLines: number,
): { startIdx: number; endIdx: number } {
  if (lineIndex.length === 0 || maxLines <= 0) {
    return { startIdx: 0, endIdx: 0 };
  }
  // Find first message whose cumulative line count crosses topLine.
  let startIdx = 0;
  for (let i = 0; i < lineIndex.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    if (lineIndex[i]!.cumulative > topLine) {
      startIdx = i;
      break;
    }
    startIdx = i + 1;
  }
  if (startIdx >= lineIndex.length) {
    startIdx = lineIndex.length - 1;
  }

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const baseCumulative = startIdx === 0 ? 0 : lineIndex[startIdx - 1]!.cumulative;
  const budgetEnd = baseCumulative + maxLines;

  let endIdx = startIdx;
  for (let i = startIdx; i < lineIndex.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    if (lineIndex[i]!.cumulative > budgetEnd) {
      endIdx = i;
      break;
    }
    endIdx = i + 1;
  }
  // Always include at least one message so a single oversize message still
  // appears (truncated naturally by terminal wrap).
  if (endIdx === startIdx) endIdx = startIdx + 1;
  return { startIdx, endIdx };
}

/**
 * Return the line offset of the START of the message at 0-based `msgIdx`
 * from the top of the full list. Used to "snap the top of the viewport to
 * message N" when scrolling by one message at a time.
 *
 *   start(0) === 0
 *   start(i) === cumulative(i-1)  for i > 0
 *   start(i) clamped to last-message start when out of range
 */
export function messageStartLine(lineIndex: MessageLineInfo[], msgIdx: number): number {
  if (msgIdx <= 0 || lineIndex.length === 0) return 0;
  const clamped = Math.min(msgIdx, lineIndex.length);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return lineIndex[clamped - 1]!.cumulative - lineIndex[clamped - 1]!.lines;
}

/** Total lines across the full message list. */
export function totalLines(lineIndex: MessageLineInfo[]): number {
  if (lineIndex.length === 0) return 0;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return lineIndex[lineIndex.length - 1]!.cumulative;
}
