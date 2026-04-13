// packages/app/src/components/chat/MessageDisplay.tsx
import { memo, useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { Message } from '@uplnk/db';
import { MessageItem } from './MessageItem.js';
import type { Artifact } from '../artifacts/ArtifactPanel.js';
import type { StreamStatus } from '../../hooks/useStream.js';
import { MarkdownMessage } from './MarkdownMessage.js'; // MarkdownMessage is used by StreamingMessageInternal

// Braille spinner — 10 frames at 160 ms gives a ~6 fps rotation.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

interface Props {
  messages: Message[];
  onPromote?: (artifact: Artifact) => void;
  // Streaming message props
  streamedText: string;
  streamStatus: StreamStatus;
  // Windowing props
  startIdx: number; // Inclusive start index for windowed view
  endIdx: number;   // Exclusive end index for windowed view
  inScrollback: boolean; // True if user is scrolled up
}

// Extracted from StreamingMessage.tsx
const StreamingMessageInternal = memo(function StreamingMessageInternal({ streamedText, streamStatus }: { streamedText: string; streamStatus: StreamStatus }) {
  // Spinner frame index — only advances while status === 'connecting'.
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  useEffect(() => {
    if (streamStatus !== 'connecting' && streamStatus !== 'waiting') return;
    const id = setInterval(() => {
      setSpinnerFrame(f => (f + 1) % SPINNER_FRAMES.length);
    }, 160);
    return () => clearInterval(id);
  }, [streamStatus]);

  // Blinking block cursor — alternates every ~530 ms while streaming.
  const [cursorOn, setCursorOn] = useState(true);
  useEffect(() => {
    if (streamStatus !== 'streaming') return;
    const id = setInterval(() => setCursorOn(v => !v), 530);
    return () => clearInterval(id);
  }, [streamStatus]);

  // Hide entirely only when there's nothing meaningful to show AND we're
  // between turns. Still keep a 1-line spacer so the layout doesn't shift.
  if (streamStatus === 'idle' || (streamStatus === 'done' && !streamedText)) {
    return <Box marginY={1} />;
  }

  if (streamStatus === 'connecting' || streamStatus === 'waiting') {
    const label = streamStatus === 'connecting' ? 'connecting…' : 'waiting for model…';
    return (
      <Box flexDirection="column" marginY={1}>
        <Box>
          <Text bold color="#60A5FA">uplnk</Text>
        </Box>
        <Box>
          <Text color="#1E40AF" dimColor>{'│ '}</Text>
          <Text color="yellow">{SPINNER_FRAMES[spinnerFrame]} </Text>
          <Text dimColor>{label}</Text>
        </Box>
      </Box>
    );
  }

  // 'streaming' or 'done' with text — render raw during streaming to keep
  // the token flush at low cost; the final committed message in MessageList
  // will have full markdown + syntax highlight applied.
  const isStreaming = streamStatus === 'streaming';

  // Detect models that output a raw function-call JSON blob instead of
  // answering conversationally.  Shape: { "name": "...", "arguments": ... }
  // at the root of the response text (optional leading/trailing whitespace).
  const isHallucinatedToolCall =
    !isStreaming &&
    streamedText.trim().startsWith('{') &&
    /^\s*\{\s*"name"\s*:/.test(streamedText) &&
    /"arguments"\s*:/.test(streamedText);

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
                {streamedText}
              </Text>
              <Text color="cyan">{cursorOn ? '▋' : ' '}</Text>
            </Box>
          ) : isHallucinatedToolCall ? (
            <Box flexDirection="column">
              <Text color="yellow">⚠ Model returned a raw function call instead of text.</Text>
              <Text dimColor>  This model may not support tool calling. Try /model to switch,</Text>
              <Text dimColor>  or ask again — the model may self-correct.</Text>
            </Box>
          ) : (
            <MarkdownMessage text={streamedText} />
          )}
        </Box>
      </Box>
    </Box>
  );
});


export const MessageDisplay = memo(function MessageDisplay({
  messages,
  onPromote,
  streamedText,
  streamStatus,
  startIdx,
  endIdx,
  inScrollback,
}: Props) {
  // If in scrollback, render only the slice of messages
  if (inScrollback) {
    const slice = messages.slice(startIdx, endIdx);
    return (
      <Box flexDirection="column">
        {slice.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            {...(onPromote !== undefined ? { onPromote } : {})}
          />
        ))}
      </Box>
    );
  }

  // Otherwise (live mode), render all committed messages + the streaming message
  return (
    <Box flexDirection="column">
      {messages.map((message) => (
        <MessageItem
          key={message.id}
          message={message}
          {...(onPromote !== undefined ? { onPromote } : {})}
        />
      ))}
      <StreamingMessageInternal streamedText={streamedText} streamStatus={streamStatus} />
    </Box>
  );
});
