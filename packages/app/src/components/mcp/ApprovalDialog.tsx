/**
 * ApprovalDialog — blocking Ink dialog for MCP command-exec approval.
 *
 * SECURITY: This dialog MUST render and receive user confirmation before
 * any command is executed. It is the Layer 2 human-in-the-loop gate.
 *
 * UX design (ref: 08-vesper-interaction-v2.md):
 * - Yellow border (warning semantic color) to signal "this requires attention"
 * - Full command is shown verbatim — no summarization or truncation
 * - Working directory shown if set
 * - Y / N / Escape to respond
 * - No default — user must make a deliberate choice
 *
 * The parent component renders this as a modal overlay by rendering it
 * on top of (or instead of) the normal ChatScreen content.
 */

import { memo } from 'react';
import { Box, Text, useInput } from 'ink';

export interface ApprovalRequest {
  id: string;
  command: string;
  args: string[];
  cwd?: string;
  /** Human-readable description of what this command does (from the LLM) */
  description?: string;
}

interface Props {
  request: ApprovalRequest;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}

export const ApprovalDialog = memo(function ApprovalDialog({
  request,
  onApprove,
  onDeny,
}: Props) {
  useInput((input, key) => {
    const ch = input.toLowerCase();

    if (ch === 'y') {
      onApprove(request.id);
      return;
    }

    if (ch === 'n' || key.escape) {
      onDeny(request.id);
      return;
    }
  });

  const fullCommand = [request.command, ...request.args].join(' ');

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="yellow"
      paddingX={2}
      paddingY={1}
      marginY={1}
    >
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="yellow">
          ⚠  MCP Command Execution Request
        </Text>
      </Box>

      {/* Command — PRIMARY display: large, prominent, always first */}
      <Box marginBottom={1} flexDirection="column">
        <Box>
          <Text color="yellow">Command: </Text>
        </Box>
        <Box marginLeft={2}>
          <Text color="white" bold>
            {fullCommand}
          </Text>
        </Box>
      </Box>

      {/* Working directory */}
      {request.cwd !== undefined && (
        <Box marginBottom={1}>
          <Text color="gray">In:      </Text>
          <Text color="white">{request.cwd}</Text>
        </Box>
      )}

      {/* AI description — SECONDARY: dim, clearly labelled as unverified LLM output */}
      {request.description !== undefined && request.description.length > 0 && (
        <Box marginBottom={1} flexDirection="column">
          <Box>
            <Text dimColor>AI description (unverified):</Text>
          </Box>
          <Box marginLeft={2}>
            <Text dimColor>{request.description}</Text>
          </Box>
        </Box>
      )}

      {/* Divider */}
      <Box marginBottom={1}>
        <Text color="#334155">{'─'.repeat(50)}</Text>
      </Box>

      {/* Prompt */}
      <Box>
        <Text color="yellow" bold>Allow this command?  </Text>
        <Text color="green">[Y] Allow</Text>
        <Text>  </Text>
        <Text color="red">[N] Deny</Text>
        <Text color="gray">  (Esc = deny)</Text>
      </Box>
    </Box>
  );
});
