import { memo, useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { StreamStatus } from '../../hooks/useStream.js';
import { MarkdownMessage } from './MarkdownMessage.js';

// Braille spinner — 10 frames at 80 ms gives a smooth ~12.5 fps rotation.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

interface Props {
  text: string;
  status: StreamStatus;
}

/**
 * Always renders a stable 3-line block (marginY=1 + 1 content row) so that
 * transitioning between idle/connecting/streaming/done does NOT change the
 * component's height. Height deltas here cause Ink's cursor tracker to drift
 * and the screen to go blank.
 *
 * During active streaming, we skip markdown parsing (render raw) to avoid
 * regex cost on every token flush — markdown is applied on the final
 * committed message in MessageList instead.
 */
export const StreamingMessage = memo(function StreamingMessage({ text, status }: Props) {
  // Spinner frame index — only advances while status === 'connecting'.
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  useEffect(() => {
    if (status !== 'connecting') return;
    const id = setInterval(() => {
      setSpinnerFrame(f => (f + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(id);
  }, [status]);

  // Blinking block cursor — alternates every ~530 ms while streaming.
  const [cursorOn, setCursorOn] = useState(true);
  useEffect(() => {
    if (status !== 'streaming') return;
    const id = setInterval(() => setCursorOn(v => !v), 530);
    return () => clearInterval(id);
  }, [status]);

  // Hide entirely only when there's nothing meaningful to show AND we're
  // between turns. Still keep a 1-line spacer so the layout doesn't shift.
  if (status === 'idle' || (status === 'done' && !text)) {
    return <Box marginY={1} />;
  }

  if (status === 'connecting') {
    return (
      <Box flexDirection="column" marginY={1}>
        <Box>
          <Text bold color="#60A5FA">uplnk</Text>
        </Box>
        <Box>
          <Text color="#1E40AF" dimColor>{'│ '}</Text>
          <Text color="yellow">{SPINNER_FRAMES[spinnerFrame]} </Text>
          <Text dimColor>connecting…</Text>
        </Box>
      </Box>
    );
  }

  // 'streaming' or 'done' with text — render raw during streaming to keep
  // the token flush at low cost; the final committed message in MessageList
  // will have full markdown + syntax highlight applied.
  const isStreaming = status === 'streaming';

  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text bold color="#60A5FA">uplnk</Text>
      </Box>
      <Box>
        <Text color="#1E40AF" dimColor>{'│ '}</Text>
        <Box flexDirection="column" flexShrink={1}>
          {isStreaming ? (
            <Box>
              <Text wrap="wrap">
                {text}
              </Text>
              <Text color="cyan">{cursorOn ? '▋' : ' '}</Text>
            </Box>
          ) : (
            <MarkdownMessage text={text} />
          )}
        </Box>
      </Box>
    </Box>
  );
});
