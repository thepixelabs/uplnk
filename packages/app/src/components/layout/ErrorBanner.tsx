import { Box, Text, useInput } from 'ink';
import type { UplnkError } from '@uplnk/shared';

interface Props {
  error: UplnkError;
  onDismiss: () => void;
}

export function ErrorBanner({ error, onDismiss }: Props) {
  useInput((_, key) => {
    if (key.escape || key.return) onDismiss();
  });

  return (
    <Box
      borderStyle="double"
      borderColor="red"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="red">✗ {error.code}</Text>
      <Text>{error.message}</Text>
      <Text dimColor>{error.hint}</Text>
      <Text dimColor>Press Enter or Esc to dismiss</Text>
    </Box>
  );
}
