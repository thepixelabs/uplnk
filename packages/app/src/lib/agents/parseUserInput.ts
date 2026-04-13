/**
 * parseAgentMention — detects `@agent-name <prompt>` at the start of user input.
 *
 * Returns { agent, prompt } if the first token matches a registered agent name,
 * null otherwise. This determines whether ChatScreen routes to the AgentOrchestrator
 * or the normal streamText path.
 */

import type { AgentDef, IAgentRegistry } from './types.js';

// Matches: @<kebab-name> <one-or-more chars of prompt>
const AGENT_MENTION_RE = /^@([a-z][a-z0-9-]*)\s+([\s\S]+)/;

export function parseAgentMention(
  input: string,
  registry: IAgentRegistry,
): { agent: AgentDef; prompt: string } | null {
  const trimmed = input.trim();
  const match = AGENT_MENTION_RE.exec(trimmed);
  if (match === null) return null;

  const [, name, prompt] = match;
  if (name === undefined || prompt === undefined) return null;

  const agent = registry.get(name);
  if (agent === undefined) return null;

  return { agent, prompt: prompt.trim() };
}
