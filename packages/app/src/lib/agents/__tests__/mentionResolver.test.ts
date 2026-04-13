/**
 * mentionResolver.ts — unit tests for MentionResolver
 */

import { describe, it, expect, vi } from 'vitest';
import { MentionResolver } from '../mentionResolver.js';
import type { IAgentRegistry, AgentDef } from '../types.js';

// Mock the fs-dependent fileMention module
vi.mock('../../fileMention.js', () => ({
  listMentionCandidates: () => ['src/index.ts', 'src/app.ts', 'README.md'],
  filterMentionCandidates: (candidates: string[], query: string, max: number) => {
    const q = query.toLowerCase();
    const filtered = q === '' ? candidates : candidates.filter((c) => c.toLowerCase().includes(q));
    return filtered.slice(0, max);
  },
}));

function makeAgent(name: string, description: string = `${name} agent`): AgentDef {
  return {
    name,
    description,
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
    sourcePath: `/agents/${name}.md`,
  };
}

function makeRegistry(agents: AgentDef[]): IAgentRegistry {
  return {
    list: () => agents,
    get: (name) => agents.find((a) => a.name === name),
    reload: async () => {},
  };
}

describe('MentionResolver', () => {
  const agents = [
    makeAgent('researcher', 'Research the web and return summaries'),
    makeAgent('summarizer', 'Summarize long text into bullet points'),
    makeAgent('coder', 'Write and review code'),
  ];
  const registry = makeRegistry(agents);
  const resolver = new MentionResolver(registry);

  it('returns all agents on empty query', () => {
    const results = resolver.resolve('', undefined);
    const agentResults = results.filter((r) => r.kind === 'agent');
    expect(agentResults).toHaveLength(3);
  });

  it('filters agents by name prefix', () => {
    const results = resolver.resolve('res', undefined);
    const agentResults = results.filter((r) => r.kind === 'agent');
    expect(agentResults).toHaveLength(1);
    expect(agentResults[0]?.name).toBe('researcher');
  });

  it('filters agents by description keyword', () => {
    const results = resolver.resolve('bullet', undefined);
    const agentResults = results.filter((r) => r.kind === 'agent');
    expect(agentResults).toHaveLength(1);
    expect(agentResults[0]?.name).toBe('summarizer');
  });

  it('returns files when projectDir is provided', () => {
    const results = resolver.resolve('', '/some/project');
    const fileResults = results.filter((r) => r.kind === 'file');
    expect(fileResults.length).toBeGreaterThan(0);
  });

  it('does not return files without projectDir', () => {
    const results = resolver.resolve('', undefined);
    expect(results.filter((r) => r.kind === 'file')).toHaveLength(0);
  });

  it('total results do not exceed 30', () => {
    // Create 25 agents
    const manyAgents = Array.from({ length: 25 }, (_, i) => makeAgent(`agent-${String(i)}`));
    const bigRegistry = makeRegistry(manyAgents);
    const bigResolver = new MentionResolver(bigRegistry);

    const results = bigResolver.resolve('', '/project');
    expect(results.length).toBeLessThanOrEqual(30);
  });

  it('file candidate has correct kind and path fields', () => {
    const results = resolver.resolve('index', '/project');
    const fileResults = results.filter((r) => r.kind === 'file');
    expect(fileResults.length).toBeGreaterThan(0);
    const first = fileResults[0];
    expect(first).toHaveProperty('kind', 'file');
    expect(first).toHaveProperty('path');
    expect(first).toHaveProperty('insertText');
  });

  it('agent candidate has correct shape', () => {
    const results = resolver.resolve('', undefined);
    const agentResults = results.filter((r) => r.kind === 'agent');
    const first = agentResults[0];
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('description');
    expect(first).toHaveProperty('icon');
    expect(first).toHaveProperty('color');
    expect(first).toHaveProperty('insertText');
  });

  it('excludes non-userInvocable agents', () => {
    const hidden = makeAgent('hidden-agent', 'Internal agent');
    const hiddenDef = { ...hidden, userInvocable: false };
    const reg = makeRegistry([...agents, hiddenDef]);
    const res = new MentionResolver(reg);

    const results = res.resolve('', undefined);
    const names = results.filter((r) => r.kind === 'agent').map((r) => r.kind === 'agent' ? r.name : '');
    expect(names).not.toContain('hidden-agent');
  });
});
