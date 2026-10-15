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

  it('injects resolved skill bodies as a wrapped untrusted-context message when skillRegistry is provided', async () => {
    const { AgentOrchestrator } = await import('../orchestrator.js');

    const skillRegistry = {
      list: () => [],
      get: () => undefined,
      reload: async () => {},
      resolve: (names: readonly string[]) =>
        names.map((n) => ({
          name: n,
          description: `${n} desc`,
          confidence: 1.0,
          status: 'published' as const,
          source: 'builtin' as const,
          sourcePath: `/${n}.md`,
          body: `Body of ${n}.`,
        })),
    };

    const orch = new AgentOrchestrator({ ...deps, skillRegistry });
    const ac = new AbortController();

    await orch.run({
      agent: makeAgentDef({ skills: ['alpha', 'beta'] }),
      userPrompt: 'hello',
      signal: ac.signal,
    });

    expect(mockStreamText).toHaveBeenCalledTimes(1);
    const callArgs = mockStreamText.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
      system?: string;
    };

    // Skill body lands as a user-role message with delimiters BEFORE the user prompt
    const wrapped = callArgs.messages.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('UNTRUSTED_SOURCE_DATA'),
    );
    expect(wrapped).toBeDefined();
    expect(wrapped!.content).toContain('label="skill:alpha"');
    expect(wrapped!.content).toContain('label="skill:beta"');
    expect(wrapped!.content).toContain('Body of alpha.');
    expect(wrapped!.content).toContain('Body of beta.');

    // The untrusted-context policy is prepended to the system prompt
    expect(callArgs.system).toContain('SECURITY POLICY');
    expect(callArgs.system).toContain('You are a test agent.');
  });

  it('does NOT inject skill content or policy when agent.skills is empty', async () => {
    const { AgentOrchestrator } = await import('../orchestrator.js');

    const skillRegistry = {
      list: () => [],
      get: () => undefined,
      reload: async () => {},
      resolve: () => [],
    };

    const orch = new AgentOrchestrator({ ...deps, skillRegistry });
    const ac = new AbortController();

    await orch.run({
      agent: makeAgentDef(), // no skills field
      userPrompt: 'hello',
      signal: ac.signal,
    });

    const callArgs = mockStreamText.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
      system?: string;
    };

    const wrapped = callArgs.messages.find(
      (m) => typeof m.content === 'string' && m.content.includes('UNTRUSTED_SOURCE_DATA'),
    );
    expect(wrapped).toBeUndefined();
    expect(callArgs.system).toBe('You are a test agent.');
  });

  it('is a silent no-op when agent.skills is set but skillRegistry dep is omitted', async () => {
    const { AgentOrchestrator } = await import('../orchestrator.js');

    const orch = new AgentOrchestrator(deps); // no skillRegistry
    const ac = new AbortController();

    await orch.run({
      agent: makeAgentDef({ skills: ['alpha'] }),
      userPrompt: 'hello',
      signal: ac.signal,
    });

    const callArgs = mockStreamText.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
      system?: string;
    };

    const wrapped = callArgs.messages.find(
      (m) => typeof m.content === 'string' && m.content.includes('UNTRUSTED_SOURCE_DATA'),
    );
    expect(wrapped).toBeUndefined();
    expect(callArgs.system).toBe('You are a test agent.');
  });

  it('applies per-call overrides for model/provider/temperature but keeps hard limits from the def', async () => {
    const { AgentOrchestrator } = await import('../orchestrator.js');

    const modelFactory = vi.fn(() => ({} as import('ai').LanguageModel));
    const orch = new AgentOrchestrator({ ...deps, modelFactory });

    const ac = new AbortController();
    await orch.run({
      agent: makeAgentDef({ temperature: 0.9, maxTurns: 7 }),
      userPrompt: 'hello',
      signal: ac.signal,
      overrides: { model: 'override-model', provider: 'override-provider', temperature: 0.1 },
    });

    // Model resolved through the SAME factory path, with the override spec
    expect(modelFactory).toHaveBeenCalledWith({
      model: 'override-model',
      provider: 'override-provider',
    });
    const callArgs = mockStreamText.mock.calls[0]![0] as {
      temperature?: number;
      maxSteps: number;
    };
    expect(callArgs.temperature).toBe(0.1);
    // Hard limits are NOT overridable — maxSteps still comes from the def
    expect(callArgs.maxSteps).toBe(7);
  });

  it('falls back to the AgentDef model/temperature when no overrides are given', async () => {
    const { AgentOrchestrator } = await import('../orchestrator.js');

    const modelFactory = vi.fn(() => ({} as import('ai').LanguageModel));
    const orch = new AgentOrchestrator({ ...deps, modelFactory });

    const ac = new AbortController();
    await orch.run({
      agent: makeAgentDef({ temperature: 0.9 }),
      userPrompt: 'hello',
      signal: ac.signal,
    });

    expect(modelFactory).toHaveBeenCalledWith({ model: 'test-model' });
    const callArgs = mockStreamText.mock.calls[0]![0] as { temperature?: number };
    expect(callArgs.temperature).toBe(0.9);
  });

  it('uses invocationIdOverride as the run id and threads resumedFromRunId into agent:start', async () => {
    const { AgentOrchestrator } = await import('../orchestrator.js');
    const orch = new AgentOrchestrator(deps);

    const events: AgentEvent[] = [];
    eventBus.subscribeAll((e) => events.push(e));

    const ac = new AbortController();
    const result = await orch.run({
      agent: makeAgentDef(),
      userPrompt: 'hello',
      signal: ac.signal,
      invocationIdOverride: 'pre-minted-run',
      resumedFromRunId: 'prior-run',
    });

    expect(result.invocationId).toBe('pre-minted-run');
    const start = events.find((e) => e.type === 'agent:start');
    expect(start).toBeDefined();
    expect(start!.invocationId).toBe('pre-minted-run');
    expect((start as { resumedFromRunId?: string }).resumedFromRunId).toBe('prior-run');
  });

  it('registers the run in the live-run registry while executing and unregisters after', async () => {
    const { AgentOrchestrator, isRunActive } = await import('../orchestrator.js');

    const seen: boolean[] = [];
    mockStreamText.mockImplementation(() => ({
      fullStream: (async function* () {
        seen.push(isRunActive('live-run-1'));
        yield { type: 'text-delta', textDelta: 'hi' };
        yield { type: 'finish', usage: { promptTokens: 1, completionTokens: 1 } };
      })(),
      text: Promise.resolve('hi'),
    }));

    const orch = new AgentOrchestrator(deps);
    const ac = new AbortController();
    await orch.run({
      agent: makeAgentDef(),
      userPrompt: 'hello',
      signal: ac.signal,
      invocationIdOverride: 'live-run-1',
    });

    expect(seen).toEqual([true]);
    expect(isRunActive('live-run-1')).toBe(false);
  });

  it('enqueueMessageForRun returns false for a run that is not active', async () => {
    const { enqueueMessageForRun } = await import('../orchestrator.js');
    expect(enqueueMessageForRun('no-such-run', 'hello?')).toBe(false);
  });

  it('drains the send_to_agent queue at the step boundary via a continuation round', async () => {
    const { AgentOrchestrator, enqueueMessageForRun } = await import('../orchestrator.js');

    mockStreamText
      .mockImplementationOnce(() => ({
        fullStream: (async function* () {
          yield { type: 'text-delta', textDelta: 'first answer' };
          yield { type: 'finish', usage: { promptTokens: 10, completionTokens: 5 } };
          // Arrives mid-run (send_to_agent) — drained at the step boundary.
          expect(enqueueMessageForRun('ext-run', 'also check the tests')).toBe(true);
        })(),
        text: Promise.resolve('first answer'),
      }))
      .mockImplementationOnce(() => ({
        fullStream: (async function* () {
          yield { type: 'text-delta', textDelta: 'second answer' };
          yield { type: 'finish', usage: { promptTokens: 4, completionTokens: 3 } };
        })(),
        text: Promise.resolve('second answer'),
      }));

    const orch = new AgentOrchestrator(deps);
    const ac = new AbortController();
    const result = await orch.run({
      agent: makeAgentDef({ maxTurns: 5 }),
      userPrompt: 'go',
      signal: ac.signal,
      invocationIdOverride: 'ext-run',
    });

    expect(mockStreamText).toHaveBeenCalledTimes(2);
    const secondArgs = mockStreamText.mock.calls[1]![0] as {
      messages: Array<{ role: string; content: string }>;
      maxSteps: number;
    };
    // Continuation transcript: prior turn + round-1 assistant text + queued user message
    const tail = secondArgs.messages.slice(-2);
    expect(tail[0]).toEqual({ role: 'assistant', content: 'first answer' });
    expect(tail[1]).toEqual({ role: 'user', content: 'also check the tests' });
    // Round 1 consumed at least one step of the def's budget
    expect(secondArgs.maxSteps).toBe(4);

    // Return contract: both rounds' text, accumulated usage
    expect(result.finalText).toBe('first answer\n\nsecond answer');
    expect(result.usage.inputTokens).toBe(14);
    expect(result.usage.outputTokens).toBe(8);
  });

  it('does not run a continuation round when nothing was queued', async () => {
    const { AgentOrchestrator } = await import('../orchestrator.js');
    const orch = new AgentOrchestrator(deps);

    const ac = new AbortController();
    await orch.run({
      agent: makeAgentDef(),
      userPrompt: 'hello',
      signal: ac.signal,
    });

    expect(mockStreamText).toHaveBeenCalledTimes(1);
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
