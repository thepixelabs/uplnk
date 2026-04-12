import { memo } from 'react';
import { Box, Text } from 'ink';

interface Props {
  modelName: string;
  conversationTitle: string;
}

export const Header = memo(function Header({ modelName, conversationTitle }: Props) {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text>
        <Text color="#60A5FA">▐</Text>
        <Text color="#60A5FA" bold>█</Text>
        <Text color="#60A5FA">▌</Text>
        <Text bold> UPLNK</Text>
      </Text>
      <Text dimColor>{conversationTitle}</Text>
      <Text color="#475569">{modelName}</Text>
    </Box>
  );
});
