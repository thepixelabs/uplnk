/**
 * orchestrator.ts — unit tests for AgentOrchestrator
 *
 * streamText is mocked at the module boundary via vi.mock().
 * Each test stubs `streamText` to return a controlled async iterable.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentDef, IAgentRegistry, AgentEvent } from '../types.js';
import type { AgentOrchestratorDeps } from '../orchestrator.js';
import { AgentEventBus } from '../eventBus.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAgentDef(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: 'test-agent',
    description: 'test',
    systemPrompt: 'You are a test agent.',
    model: 'test-model',
    maxDepth: 1,
    memory: 'none',
    color: 'cyan',
    icon: '🤖',
    userInvocable: true,
    maxTurns: 5,
    timeoutMs: 30_000,
    source: 'builtin',
    sourcePath: '/test.md',
    agents: [],
    ...overrides,
  };
}

function makeRegistry(agents: AgentDef[] = []): IAgentRegistry {
  const map = new Map(agents.map((a) => [a.name, a]));
  return {
    list: () => Array.from(map.values()),
    get: (name) => map.get(name),
    reload: async () => {},
  };
}

// Build a fake fullStream async iterable
async function* makeStream(
  parts: Array<{ type: 'text-delta'; textDelta: string } | { type: 'finish'; usage: { promptTokens: number; completionTokens: number } }>
) {
  for (const part of parts) {
    yield part;
  }
}

// ── Mock streamText ───────────────────────────────────────────────────────────

const mockStreamText = vi.fn();

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: (...args: unknown[]) => mockStreamText(...args),
  };
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentOrchestrator', () => {
  let eventBus: AgentEventBus;
  let deps: AgentOrchestratorDeps;

  beforeEach(async () => {
    vi.clearAllMocks();

    eventBus = new AgentEventBus();

    const stream = makeStream([
      { type: 'text-delta', textDelta: 'Hello' },
      { type: 'text-delta', textDelta: ' world' },
      { type: 'finish', usage: { promptTokens: 10, completionTokens: 5 } },
    ]);

    mockStreamText.mockReturnValue({
      fullStream: stream,
      text: Promise.resolve('Hello world'),
    });

    deps = {
      registry: makeRegistry(),
      modelFactory: () => ({} as import('ai').LanguageModel),
      rootTools: {},
      eventBus,
    };
  });

  it('emits agent:start and agent:end events', async () => {
    const { AgentOrchestrator } = await import('../orchestrator.js');
    const orch = new AgentOrchestrator(deps);

    const events: AgentEvent[] = [];
    eventBus.subscribeAll((e) => events.push(e));

    const ac = new AbortController();
    await orch.run({
      agent: makeAgentDef(),
      userPrompt: 'hello',
      signal: ac.signal,
    });

    const types = events.map((e) => e.type);
    expect(types).toContain('agent:start');
    expect(types).toContain('agent:end');
  });

  it('returns finalText from stream', async () => {
    const { AgentOrchestrator } = await import('../orchestrator.js');
    const orch = new AgentOrchestrator(deps);

    const ac = new AbortController();
    const result = await orch.run({
      agent: makeAgentDef(),
      userPrompt: 'hello',
      signal: ac.signal,
    });

    expect(result.finalText).toBe('Hello world');
  });

  it('emits text:delta for each text chunk', async () => {
    const { AgentOrchestrator } = await import('../orchestrator.js');
    const orch = new AgentOrchestrator(deps);

    const events: AgentEvent[] = [];
    eventBus.subscribeAll((e) => events.push(e));

    const ac = new AbortController();
    await orch.run({
      agent: makeAgentDef(),
      userPrompt: 'hello',
      signal: ac.signal,
    });

    const deltas = events.filter((e) => e.type === 'text:delta');
    expect(deltas).toHaveLength(2);
  });

  it('uses rootInvocationIdOverride as rootInvocationId', async () => {
    const { AgentOrchestrator } = await import('../orchestrator.js');
    const orch = new AgentOrchestrator(deps);

    const events: AgentEvent[] = [];
    eventBus.subscribeAll((e) => events.push(e));

    const ac = new AbortController();
    await orch.run({
      agent: makeAgentDef(),
      userPrompt: 'hello',
      signal: ac.signal,
      rootInvocationIdOverride: 'my-root-id',
    });

    expect(events.every((e) => e.rootInvocationId === 'my-root-id')).toBe(true);
  });

  it('records usage from finish event', async () => {
    const { AgentOrchestrator } = await import('../orchestrator.js');
    const orch = new AgentOrchestrator(deps);

    const ac = new AbortController();
    const result = await orch.run({
      agent: makeAgentDef(),
      userPrompt: 'hello',
      signal: ac.signal,
    });

    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
  });

  it('throws when global depth cap is exceeded', async () => {
    const { AgentOrchestrator } = await import('../orchestrator.js');
    const orch = new AgentOrchestrator(deps);

    const ac = new AbortController();
    const agent = makeAgentDef({ name: 'deep-agent' });

    await expect(
      orch.run({
        agent,
        userPrompt: 'hello',
        signal: ac.signal,
        parent: {
          invocationId: 'parent',
          depth: 5, // already at GLOBAL_MAX_DEPTH
          ancestry: ['a', 'b', 'c', 'd', 'e'],
          rootInvocationId: 'root',
          state: {},
          nextSeq: () => 0,
          inheritedModel: {} as import('ai').LanguageModel,
          inheritedTools: {},
        },
      })
    ).rejects.toThrow(/depth cap/i);
  });

  it('emits agent:aborted when signal is aborted', async () => {
    const { AgentOrchestrator } = await import('../orchestrator.js');

    // Make the stream throw an AbortError
    const abortable = (async function* () {
      const err = new Error('AbortError');
      err.name = 'AbortError';
      throw err;
    })();

    // Suppress the unhandled rejection warning by attaching a catch handler
    const textPromise = Promise.reject(new Error('aborted'));
    textPromise.catch(() => {}); // intentionally suppress

    mockStreamText.mockReturnValue({
      fullStream: abortable,
      text: textPromise,
    });

    const orch = new AgentOrchestrator(deps);
    const events: AgentEvent[] = [];
    eventBus.subscribeAll((e) => events.push(e));

    const ac = new AbortController();
    ac.abort(); // abort before run

    await expect(
      orch.run({
        agent: makeAgentDef(),
        userPrompt: 'hello',
        signal: ac.signal,
      })
    ).rejects.toBeDefined();

    const abortedEvents = events.filter((e) => e.type === 'agent:aborted');
    expect(abortedEvents).toHaveLength(1);
  });
});
