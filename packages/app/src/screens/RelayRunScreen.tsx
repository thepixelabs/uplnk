/**
 * RelayRunScreen — execute a relay plan and stream both phases to the screen.
 *
 * Calls runRelayPlan on mount. Shows the Scout phase (blue) streaming first,
 * then a visual separator, then the Anchor phase (purple). When complete,
 * shows a summary footer with keyboard hints.
 */

import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useWorkflow } from '../hooks/useWorkflow.js';
import type { RelayPlan } from '../lib/workflows/planSchema.js';

interface Props {
  plan: RelayPlan;
  userInput: string;
  onBack: () => void;
  /**
   * Called when the relay run completes successfully (status === 'completed').
   * Useful for callers that want to return to the picker or chat automatically
   * instead of waiting for the user to press Esc.
   */
  onDone?: () => void;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function makeSeparator(totalWidth = 67): string {
  const label = ' Scout complete · Anchor up ';
  const lineLen = Math.max(0, totalWidth - label.length);
  const left = Math.floor(lineLen / 2);
  const right = lineLen - left;
  return '─'.repeat(left) + label + '─'.repeat(right);
}

export function RelayRunScreen({ plan, userInput, onBack, onDone }: Props) {
  const { scoutText, anchorText, status, error, runRelayPlan, abort } = useWorkflow();

  const [frame, setFrame] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Run the plan on mount — empty deps is intentional.
  useEffect(() => {
    void runRelayPlan(plan, userInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fire onDone when the relay completes (if caller provided it).
  useEffect(() => {
    if (status === 'completed' && onDone !== undefined) {
      onDone();
    }
  }, [status, onDone]);

  // Spinner — active during scout-running and anchor-running.
  const isSpinning = status === 'scout-running' || status === 'anchor-running';
  useEffect(() => {
    if (isSpinning) {
      intervalRef.current = setInterval(() => {
        setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
      }, 100);
    } else {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isSpinning]);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      abort();
      onBack();
      return;
    }
    // s = save to history — no-op placeholder; hook already persists.
    if (input === 's' && status === 'completed') {
      return;
    }
  });

  const spinner = SPINNER_FRAMES[frame] ?? '⠋';
  const termWidth = process.stdout.columns ?? 67;
  const separator = makeSeparator(termWidth - 2); // -2 for the 1-char left padding each side

  const scoutModel = plan.scout.model;
  const anchorModel = plan.anchor.model;

  const scoutHeader = `── ${scoutModel} ${'─'.repeat(Math.max(0, 40 - scoutModel.length))}`;
  const anchorHeader = `── ${anchorModel} ${'─'.repeat(Math.max(0, 40 - anchorModel.length))}`;

  const showSeparator =
    status === 'scout-done' ||
    status === 'anchor-running' ||
    status === 'completed' ||
    status === 'error';

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box>
        <Text>relay: <Text bold>{plan.name}</Text></Text>
        <Text>{'   '}</Text>
        <Text dimColor>{scoutModel} → {anchorModel}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {/* Scout phase */}
        <Box>
          <Text color="#60A5FA">Scout</Text>
          <Text dimColor>  {scoutHeader}</Text>
        </Box>

        {status === 'scout-running' && scoutText === '' && (
          <Box marginTop={1}>
            <Text color="#60A5FA">{spinner} </Text>
            <Text dimColor>Scout is analyzing…</Text>
          </Box>
        )}

        {scoutText !== '' && (
          <Box marginTop={1}>
            <Text>{scoutText}</Text>
          </Box>
        )}

        {status === 'scout-running' && scoutText !== '' && (
          <Text color="#60A5FA">{spinner}</Text>
        )}

        {/* Separator — only after scout completes */}
        {showSeparator && (
          <Box marginTop={1}>
            <Text dimColor>{separator}</Text>
          </Box>
        )}

        {/* Anchor phase — only after separator appears */}
        {showSeparator && (
          <Box marginTop={1} flexDirection="column">
            <Box>
              <Text color="#A78BFA">Anchor</Text>
              <Text dimColor>  {anchorHeader}</Text>
            </Box>

            {status === 'anchor-running' && anchorText === '' && (
              <Box marginTop={1}>
                <Text color="#A78BFA">{spinner} </Text>
                <Text dimColor>Anchor is responding…</Text>
              </Box>
            )}

            {anchorText !== '' && (
              <Box marginTop={1}>
                <Text>{anchorText}</Text>
              </Box>
            )}

            {status === 'anchor-running' && anchorText !== '' && (
              <Text color="#A78BFA">{spinner}</Text>
            )}
          </Box>
        )}

        {/* Error state */}
        {status === 'error' && error !== null && (
          <Box marginTop={1}>
            <Text color="red">Error: {error.message}</Text>
          </Box>
        )}

        {/* Completed footer */}
        {status === 'completed' && (
          <Box marginTop={1}>
            <Text color="#4ADE80">Relay complete.</Text>
            <Text dimColor>   s save-to-history  Esc back</Text>
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Esc cancel  s save-to-history (done when relay completes)</Text>
      </Box>
    </Box>
  );
}
