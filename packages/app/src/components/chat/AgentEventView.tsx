/**
 * AgentEventView — renders a streaming multi-agent invocation tree in the TUI.
 *
 * Groups events by invocationId, draws a colored left-rail per agent,
 * indents by depth, and updates live as events arrive.
 */

import { memo } from 'react';
import { Box, Text } from 'ink';
import type { AgentEvent, AgentColor, InvocationId, IAgentRegistry } from '../../lib/agents/types.js';

interface Props {
  rootInvocationId: InvocationId;
  events: AgentEvent[];
  registry: IAgentRegistry;
}

interface InvocationGroup {
  invocationId: InvocationId;
  agentName: string;
  depth: number;
  textChunks: string[];
  toolCalls: Array<{ toolCallId: string; toolName: string }>;
  delegations: Array<{ childAgent: string; mode: 'delegate' | 'ask' }>;
  endEvent?: { durationMs: number; inputTokens: number; outputTokens: number };
  errorEvent?: { message: string };
  aborted?: boolean;
}

function buildGroups(events: AgentEvent[]): Map<InvocationId, InvocationGroup> {
  const groups = new Map<InvocationId, InvocationGroup>();

  for (const event of events) {
    let group = groups.get(event.invocationId);
    if (group === undefined) {
      group = {
        invocationId: event.invocationId,
        agentName: event.agentName,
        depth: event.depth,
        textChunks: [],
        toolCalls: [],
        delegations: [],
      };
      groups.set(event.invocationId, group);
    }

    switch (event.type) {
      case 'text:delta':
        group.textChunks.push(event.delta);
        break;
      case 'tool:call':
        group.toolCalls.push({ toolCallId: event.toolCallId, toolName: event.toolName });
        break;
      case 'delegate:spawn':
        group.delegations.push({ childAgent: event.childAgent, mode: event.mode });
        break;
      case 'agent:end':
        group.endEvent = {
          durationMs: event.durationMs,
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
        };
        break;
      case 'agent:error':
        group.errorEvent = { message: event.error.message };
        break;
      case 'agent:aborted':
        group.aborted = true;
        break;
    }
  }

  return groups;
}

// Resolve agent color from registry, fall back to 'cyan'
function resolveColor(agentName: string, registry: IAgentRegistry): AgentColor {
  return registry.get(agentName)?.color ?? 'cyan';
}

function resolveIcon(agentName: string, registry: IAgentRegistry): string {
  return registry.get(agentName)?.icon ?? '🤖';
}

// Convert AgentColor to an Ink-compatible color string
function toInkColor(color: AgentColor): string {
  // Named colors ink supports directly; hex colors work too
  return color;
}

const AgentGroup = memo(function AgentGroup({
  group,
  registry,
}: {
  group: InvocationGroup;
  registry: IAgentRegistry;
}) {
  const color = toInkColor(resolveColor(group.agentName, registry));
  const icon = resolveIcon(group.agentName, registry);
  const indent = '  '.repeat(Math.max(0, group.depth - 1));
  const bodyIndent = indent + '  ';
  const fullText = group.textChunks.join('');

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Text color={color}>
        {indent}{icon}{' '}
        <Text bold>@{group.agentName}</Text>
      </Text>

      {/* Streaming text */}
      {fullText.length > 0 && (
        <Box paddingLeft={bodyIndent.length}>
          <Text>{fullText}</Text>
        </Box>
      )}

      {/* Tool calls */}
      {group.toolCalls.map((tc) => (
        <Text key={tc.toolCallId} dimColor>
          {bodyIndent}↳ {tc.toolName}(…)
        </Text>
      ))}

      {/* Delegations */}
      {group.delegations.map((d, i) => (
        <Text key={i} dimColor>
          {bodyIndent}⇒ {d.mode === 'delegate' ? 'delegating to' : 'asking'} @{d.childAgent}…
        </Text>
      ))}

      {/* End line */}
      {group.endEvent !== undefined && (
        <Text dimColor>
          {bodyIndent}✓ done ({group.endEvent.durationMs}ms · {group.endEvent.inputTokens + group.endEvent.outputTokens} tok)
        </Text>
      )}

      {/* Error */}
      {group.errorEvent !== undefined && (
        <Text color="red">
          {bodyIndent}✗ error: {group.errorEvent.message}
        </Text>
      )}

      {/* Aborted */}
      {group.aborted === true && (
        <Text dimColor>{bodyIndent}⊘ aborted</Text>
      )}
    </Box>
  );
});

export const AgentEventView = memo(function AgentEventView({
  rootInvocationId,
  events,
  registry,
}: Props) {
  const filtered = events.filter((e) => e.rootInvocationId === rootInvocationId);
  if (filtered.length === 0) return null;

  const groups = buildGroups(filtered);

  return (
    <Box flexDirection="column" marginTop={1}>
      {Array.from(groups.values()).map((group) => (
        <AgentGroup key={group.invocationId} group={group} registry={registry} />
      ))}
    </Box>
  );
});
