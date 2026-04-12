import { Box, Text, useInput } from 'ink';

interface Props {
  onSelect: () => void;
  onBack: () => void;
}

export function ConversationListScreen({ onSelect, onBack }: Props) {
  useInput((_, key) => {
    if (key.escape) onBack();
    if (key.return) onSelect();
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Conversations  (Enter select, Esc back)</Text>
      <Box marginTop={1}>
        <Text dimColor>No saved conversations yet. Start chatting!</Text>
      </Box>
    </Box>
  );
}
