/**
 * CompareScreen — split-pane blind A/B (or A/B/C/…) comparison of multiple
 * models against the same prompt. Phase E.2.4.
 *
 * Layout:
 *   header strip (mode • blind status • abort hint)
 *   row of N panes, side-by-side when terminalWidth ≥ 80×N, stacked otherwise
 *   per-pane header (label + status), body (streamed markdown), footer (timing)
 *   vote bar + scoreboard mini-row
 *
 * Keybinds:
 *   v/b/c/d/e/f/g/h  vote pane 0..7 (depending on pane count)
 *   t                tie
 *   r                reveal labels (blind mode only)
 *   n                new prompt (clears panes, re-blinds)
 *   x or Esc         exit (Esc also aborts in-flight streams first)
 */

import { useCallback, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { MarkdownMessage } from '../components/chat/MarkdownMessage.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useCompare, MAX_COMPARE_PANES, type ComparePaneState, type UseCompareOptions } from '../hooks/useCompare.js';

const VOTE_KEYS = ['v', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;
const MIN_PANE_WIDTH = 40;

interface Props {
  /** Models to compare (≤ 8). */
  models: UseCompareOptions['models'];
  /** Blind labels by default. */
  blind?: boolean;
  /** Parallel by default. */
  parallel?: boolean;
  /** Mode tag stored with each vote. */
  mode?: 'chat' | 'research';
  /** Called when the user exits (Esc / x). */
  onExit: () => void;
  /** Optional: a callback fired when the user requests a new prompt — caller
   *  typically opens an input modal/screen. If not provided, the screen owns
   *  a small inline prompt textbox (deferred — for now this is required). */
  onRequestPrompt: () => Promise<string | null> | string | null;
}

function statusGlyph(status: ComparePaneState['status']): string {
  switch (status) {
    case 'idle': return '·';
    case 'waiting': return '◌';
    case 'streaming': return '◆';
    case 'done': return '✓';
    case 'aborted': return '⊘';
    case 'error': return '✗';
  }
}

function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${String(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function CompareScreen({
  models,
  blind = true,
  parallel = true,
  mode = 'chat',
  onExit,
  onRequestPrompt,
}: Props) {
  if (models.length > MAX_COMPARE_PANES) {
    return (
      <Box>
        <Text color="red">CompareScreen supports at most {String(MAX_COMPARE_PANES)} panes (got {String(models.length)}).</Text>
      </Box>
    );
  }

  const compareOpts: UseCompareOptions = useMemo(() => {
    const opts: UseCompareOptions = { models, blind, parallel };
    if (mode !== undefined) {
      (opts as { mode: 'chat' | 'research' }).mode = mode;
    }
    return opts;
  }, [models, blind, parallel, mode]);

  const compare = useCompare(compareOpts);
  const { columns } = useTerminalSize();
  const [lastVote, setLastVote] = useState<string | null>(null);

  const stacked = columns < MIN_PANE_WIDTH * compare.panes.length;

  const handleNewPrompt = useCallback(async () => {
    const next = await onRequestPrompt();
    if (next === null || next === '') return;
    setLastVote(null);
    await compare.submit(next);
  }, [compare, onRequestPrompt]);

  useInput((input, key) => {
    if (key.escape) {
      compare.abortAll();
      onExit();
      return;
    }
    if (input === 'x') {
      compare.abortAll();
      onExit();
      return;
    }
    if (input === 'n' && !compare.isStreaming) {
      void handleNewPrompt();
      return;
    }
    if (input === 'r' && compare.blinded) {
      compare.reveal();
      return;
    }
    if (input === 't' && !compare.isStreaming) {
      compare.vote('tie');
      setLastVote('tie');
      return;
    }
    const voteIdx = VOTE_KEYS.indexOf(input as typeof VOTE_KEYS[number]);
    if (voteIdx !== -1 && voteIdx < compare.panes.length && !compare.isStreaming) {
      compare.vote(voteIdx);
      const pane = compare.panes[voteIdx];
      setLastVote(pane !== undefined ? pane.displayLabel : null);
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text bold>Compare</Text>
        <Text>{'   '}</Text>
        <Text dimColor>mode: {mode}</Text>
        <Text>{'   '}</Text>
        <Text dimColor>{compare.blinded ? 'blind' : 'revealed'}</Text>
        <Text>{'   '}</Text>
        <Text dimColor>{parallel ? 'parallel' : 'sequential'}</Text>
        {compare.isStreaming && (
          <>
            <Text>{'   '}</Text>
            <Text color="#60A5FA">streaming…</Text>
          </>
        )}
      </Box>

      <Box marginTop={1} flexDirection={stacked ? 'column' : 'row'}>
        {compare.panes.map((pane) => (
          <Box
            key={pane.index}
            flexDirection="column"
            borderStyle="single"
            borderColor={pane.status === 'streaming' ? '#60A5FA' : 'gray'}
            paddingX={1}
            {...(stacked ? { marginBottom: 1 } : { marginRight: 1 })}
            flexGrow={1}
            flexBasis={0}
            minWidth={MIN_PANE_WIDTH}
          >
            <Box>
              <Text bold>{pane.displayLabel}</Text>
              <Text>{'  '}</Text>
              <Text dimColor>{statusGlyph(pane.status)} {pane.status}</Text>
              <Text>{'  '}</Text>
              <Text dimColor>ttft {formatMs(pane.firstTokenMs)}</Text>
              <Text>{'  '}</Text>
              <Text dimColor>total {formatMs(pane.finishMs)}</Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
              {pane.streamedText !== '' ? (
                <MarkdownMessage text={pane.streamedText} />
              ) : (
                <Text dimColor>—</Text>
              )}
              {pane.error !== null && (
                <Box marginTop={1}>
                  <Text color="red">{pane.error.message}</Text>
                </Box>
              )}
            </Box>
          </Box>
        ))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Box>
          {compare.panes.map((pane, i) => (
            <Text key={pane.index} dimColor>
              [{VOTE_KEYS[i] ?? '?'}] {pane.displayLabel}{'  '}
            </Text>
          ))}
          <Text dimColor>[t] tie  </Text>
          {compare.blinded && <Text dimColor>[r] reveal  </Text>}
          <Text dimColor>[n] new prompt  </Text>
          <Text dimColor>[x] exit</Text>
        </Box>

        {lastVote !== null && (
          <Box>
            <Text color="green">recorded vote: {lastVote}</Text>
          </Box>
        )}

        {compare.scoreboard.length > 0 && (
          <Box marginTop={1}>
            <Text dimColor>scoreboard: </Text>
            {compare.scoreboard.slice(0, 8).map((row) => (
              <Text key={row.model} dimColor>
                {row.model.slice(0, 16)} {String(row.wins)}W-{String(row.losses)}L{'  '}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}
