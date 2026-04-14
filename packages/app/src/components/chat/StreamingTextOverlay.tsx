import { memo, useEffect, useReducer } from 'react';
import { Box, Text } from 'ink';

interface Props {
  textRef: React.MutableRefObject<string>;
  subscribe: (cb: () => void) => () => void;
  /** true while status === 'streaming' */
  isStreaming: boolean;
}

export const StreamingTextOverlay = memo(function StreamingTextOverlay({
  textRef,
  subscribe,
  isStreaming,
}: Props) {
  // forceRender is called by the subscription on each 33ms flush.
  // Only THIS component re-renders — ChatScreen stays still.
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!isStreaming) return;
    return subscribe(forceRender);
  }, [isStreaming, subscribe]);

  if (!isStreaming || textRef.current.length === 0) return null;

  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text bold color="#60A5FA">uplnk</Text>
      </Box>
      <Box>
        <Text dimColor>{'│ '}</Text>
        <Box flexShrink={1}>
          <Text wrap="wrap">{textRef.current}</Text>
        </Box>
      </Box>
    </Box>
  );
});
