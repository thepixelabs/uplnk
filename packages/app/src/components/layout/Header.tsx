import { Box, Text } from 'ink';
import { WORDMARK, colors } from '../../lib/colors.js';

interface Props {
  modelName: string;
  conversationTitle: string;
}

export function Header({ modelName, conversationTitle }: Props) {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text>{WORDMARK}</Text>
      <Text dimColor>{conversationTitle}</Text>
      <Text>{colors.muted(modelName)}</Text>
    </Box>
  );
}
