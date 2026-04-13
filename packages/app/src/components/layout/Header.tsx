import { memo } from 'react';
import { Box, Text } from 'ink';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';

interface Props {
  modelName: string;
  conversationTitle: string;
  currentDirectory: string;
  version: string;
  connectionLabel: string;
  connectionDetail: string;
  connectionColor: string;
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  const keep = maxLength - 1;
  const left = Math.ceil(keep / 2);
  const right = Math.floor(keep / 2);
  return `${value.slice(0, left)}…${value.slice(value.length - right)}`;
}

function compactPath(value: string): string {
  const home = process.env.HOME;
  const withHome = home !== undefined && value.startsWith(home)
    ? `~${value.slice(home.length)}`
    : value;
  return truncateMiddle(withHome, 24);
}

export const Header = memo(function Header({
  modelName,
  conversationTitle,
  currentDirectory,
  version,
  connectionLabel,
  connectionDetail,
  connectionColor,
}: Props) {
  const { columns } = useTerminalSize();

  return (
    <Box
      borderStyle="single"
      borderColor="#374151"
      paddingX={1}
      width={columns > 0 ? columns : undefined}
      flexShrink={0}
      flexDirection="row"
    >
      <Box borderStyle="single" borderColor="#374151" paddingX={1} marginRight={1} flexDirection="column" minWidth={30}>
        <Text>
          <Text color="#60A5FA">▐</Text>
          <Text color="#60A5FA" bold>█</Text>
          <Text color="#60A5FA">▌</Text>
          <Text bold> UPLNK</Text>
          <Text dimColor>{`  v${version}`}</Text>
        </Text>
        <Text color="#6B7280">{`cwd ${compactPath(currentDirectory)}`}</Text>
      </Box>

      <Box flexGrow={1} flexDirection="column" justifyContent="center" minWidth={12}>
        <Text bold>{truncateMiddle(conversationTitle, 24)}</Text>
        <Text color="#00D9FF">{truncateMiddle(modelName, 24)}</Text>
      </Box>

      <Box borderStyle="single" borderColor={connectionColor} paddingX={1} marginLeft={1} flexDirection="column" minWidth={28}>
        <Text color={connectionColor}>{truncateMiddle(connectionLabel, 26)}</Text>
        <Text dimColor>{truncateMiddle(connectionDetail, 26)}</Text>
      </Box>
    </Box>
  );
});
