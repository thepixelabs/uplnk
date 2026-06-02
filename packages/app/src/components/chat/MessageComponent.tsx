import { memo } from 'react';
import { Box, Text } from 'ink';
import type { Message } from '@uplnk/db';
import { MarkdownMessage } from './MarkdownMessage.js';
import type { Artifact } from '../artifacts/ArtifactPanel.js';

interface MessageComponentProps {
  message: Message;
  onPromote?: (artifact: Artifact) => void;
  isUser: boolean;
  isSystem: boolean;
  displayName?: string;
  isCursorTarget?: boolean;
  index?: number;
}

export const MessageComponent = memo(function MessageComponent({
  message,
  onPromote,
  isUser,
  isSystem,
  displayName,
  isCursorTarget,
  index,
}: MessageComponentProps) {
  if (isSystem) {
    return (
      <Box marginY={1}>
        <Text color="gray" italic>[system] {message.content ?? ''}</Text>
      </Box>
    );
  }

  const agentName =
    !isUser && typeof message.senderAgentName === 'string' && message.senderAgentName !== ''
      ? message.senderAgentName
      : null;

  const content = message.content ?? '';
  const isHallucinatedToolCall =
    !isUser &&
    content.trim().startsWith('{') &&
    /^\s*\{\s*"name"\s*:/.test(content) &&
    /"arguments"\s*:/.test(content);

  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        {isCursorTarget
          ? <Text color="#A78BFA" bold>{'▶ '}</Text>
          : <Text>{'  '}</Text>
        }
        <Text bold color={isUser ? 'white' : agentName !== null ? '#A78BFA' : '#60A5FA'}>
          {isUser ? `  ${displayName ?? 'you'}  ` : agentName !== null ? `@${agentName}` : 'uplnk'}
        </Text>
        {index !== undefined && (
          <Text dimColor>{` #${index}`}</Text>
        )}
      </Box>
      <Box>
        {!isUser && <Text dimColor>{'│ '}</Text>}
        <Box flexDirection="column" flexShrink={1}>
          {isUser ? (
            <Text wrap="wrap">{content}</Text>
          ) : isHallucinatedToolCall ? (
            <Box flexDirection="column">
              <Text color="yellow">⚠ Model returned a raw tool-call JSON instead of invoking the tool.</Text>
              <Text dimColor>  Your current model doesn't reliably support tool calling.</Text>
              <Text dimColor>  Switch via /model to a tool-capable model (e.g. qwen2.5-coder, llama3-groq-tool-use, mistral-nemo, or any OpenAI-compatible model with native function calling).</Text>
              <Box marginTop={1}>
                <Text dimColor wrap="wrap">{content}</Text>
              </Box>
            </Box>
          ) : (
            <MarkdownMessage
              text={content}
              messageId={message.id}
              {...(onPromote !== undefined ? { onPromote } : {})}
            />
          )}
        </Box>
      </Box>
    </Box>
  );
});
