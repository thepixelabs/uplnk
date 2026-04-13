/**
 * parseUserInput.ts — unit tests for parseAgentMention
 */

import { describe, it, expect } from 'vitest';
import { parseAgentMention } from '../parseUserInput.js';
import type { IAgentRegistry, AgentDef } from '../types.js';

function makeAgent(name: string): AgentDef {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: '',
    model: 'inherit',
    maxDepth: 1,
    memory: 'none',
    color: 'cyan',
    icon: '🤖',
    userInvocable: true,
    maxTurns: 10,
    timeoutMs: 600_000,
    source: 'builtin',
    sourcePath: `/path/${name}.md`,
  };
}

function makeRegistry(names: string[]): IAgentRegistry {
  const agents = new Map(names.map((n) => [n, makeAgent(n)]));
  return {
    list: () => Array.from(agents.values()),
    get: (name: string) => agents.get(name),
    reload: async () => {},
  };
}

describe('parseAgentMention', () => {
  const registry = makeRegistry(['researcher', 'summarizer', 'my-agent']);

  it('returns null for plain message', () => {
    expect(parseAgentMention('hello world', registry)).toBeNull();
  });

  it('returns null when no space after @name', () => {
    expect(parseAgentMention('@researcher', registry)).toBeNull();
  });

  it('returns null when agent is not in registry', () => {
    expect(parseAgentMention('@unknown do something', registry)).toBeNull();
  });

  it('parses a valid @mention', () => {
    const result = parseAgentMention('@researcher find the answer', registry);
    expect(result).not.toBeNull();
    expect(result!.agent.name).toBe('researcher');
    expect(result!.prompt).toBe('find the answer');
  });

  it('parses hyphenated agent name', () => {
    const result = parseAgentMention('@my-agent do a thing', registry);
    expect(result).not.toBeNull();
    expect(result!.agent.name).toBe('my-agent');
  });

  it('preserves multiline prompt', () => {
    const result = parseAgentMention('@researcher line one\nline two', registry);
    expect(result).not.toBeNull();
    expect(result!.prompt).toContain('line one');
    expect(result!.prompt).toContain('line two');
  });

  it('trims leading/trailing whitespace from entire input', () => {
    const result = parseAgentMention('  @researcher hello  ', registry);
    expect(result).not.toBeNull();
    expect(result!.agent.name).toBe('researcher');
  });

  it('returns null for @mention not at start', () => {
    expect(parseAgentMention('hey @researcher do stuff', registry)).toBeNull();
  });

  it('returns null for empty prompt after trim', () => {
    // regex requires \s+ then at least one char, so pure whitespace won't match
    expect(parseAgentMention('@researcher   ', registry)).toBeNull();
  });
});
