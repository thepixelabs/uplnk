/**
 * agentRunner.ts — unit tests for buildAgentRunner.
 *
 * The orchestrator, registries, and model factory are mocked at their module
 * boundaries; @uplnk/db comes from the global setup stub. What we exercise is
 * the factory's own logic: agent resolution + error message, step-level model
 * override (clone, not mutate), summary/runId mapping, default AbortSignal,
 * and the 'inherit' model fallback chain in the modelFactory it wires.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mock refs ─────────────────────────────────────────────────────────

const orchestratorMocks = vi.hoisted(() => ({
  run: vi.fn(),
  ctorDeps: [] as unknown[],
}));

const registryMocks = vi.hoisted(() => ({
  agents: new Map<string, { name: string; model: string }>(),
}));

// ─── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../lib/agents/orchestrator.js', () => ({
  AgentOrchestrator: class {
    run = orchestratorMocks.run;
    constructor(deps: unknown) {
      orchestratorMocks.ctorDeps.push(deps);
    }
  },
}));

vi.mock('../../lib/agents/registry.js', () => ({
  getAgentRegistry: vi.fn(() => ({
    get: (name: string) => registryMocks.agents.get(name),
    list: () => [...registryMocks.agents.values()],
    reload: vi.fn(),
  })),
}));

vi.mock('../../lib/agents/eventBus.js', () => ({
  getGlobalAgentEventBus: vi.fn(() => ({ emitEvent: vi.fn() })),
}));

vi.mock('../../lib/skills/registry.js', () => ({
  getSkillRegistry: vi.fn(() => ({ resolve: vi.fn(() => []) })),
}));

vi.mock('../../lib/memory/index.js', () => ({
  getMemoryRegistry: vi.fn(() => ({})),
  MemoryStore: class {},
}));

vi.mock('../../lib/languageModelFactory.js', () => ({
  createLanguageModel: vi.fn((input: { modelId: string }) => ({
    specificationVersion: 'v1',
    provider: 'fake',
    modelId: input.modelId,
  })),
}));

vi.mock('../../lib/secrets.js', () => ({
  resolveSecret: vi.fn(() => 'test-api-key'),
}));

// ─── Imports under test ────────────────────────────────────────────────────────

import { buildAgentRunner } from '../agentRunner.js';
import { createLanguageModel } from '../../lib/languageModelFactory.js';
import { getDefaultProvider } from '@uplnk/db';
import { makeFakeProviderRow } from '../../__tests__/helpers/fakeProviderRow.js';
import { makeTestConfig } from '../../__tests__/fixtures/config.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const RESEARCHER = { name: 'researcher', model: 'qwen2.5:7b' };

beforeEach(() => {
  vi.clearAllMocks();
  orchestratorMocks.ctorDeps.length = 0;
  registryMocks.agents.clear();
  registryMocks.agents.set('researcher', { ...RESEARCHER });
  orchestratorMocks.run.mockResolvedValue({
    invocationId: 'inv-01',
    finalText: 'the summary',
    usage: { inputTokens: 1, outputTokens: 2 },
  });
  vi.mocked(getDefaultProvider).mockReturnValue(makeFakeProviderRow());
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildAgentRunner', () => {
  it('maps the orchestrator result to { summary, runId }', async () => {
    const runner = buildAgentRunner({ config: makeTestConfig() });

    const result = await runner({ agentName: 'researcher', prompt: 'investigate' });

    expect(result).toEqual({ summary: 'the summary', runId: 'inv-01' });
    expect(orchestratorMocks.run).toHaveBeenCalledOnce();
    const runOpts = orchestratorMocks.run.mock.calls[0]?.[0] as {
      agent: { name: string };
      userPrompt: string;
      signal: AbortSignal;
    };
    expect(runOpts.agent.name).toBe('researcher');
    expect(runOpts.userPrompt).toBe('investigate');
    // A signal is always supplied — orchestrator.run requires one.
    expect(runOpts.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws a clear error listing available agents for an unknown agent name', async () => {
    const runner = buildAgentRunner({ config: makeTestConfig() });

    await expect(
      runner({ agentName: 'nope', prompt: 'go' }),
    ).rejects.toThrow('Unknown agent "nope". Available agents: researcher');
    expect(orchestratorMocks.run).not.toHaveBeenCalled();
  });

  it('applies a step-level model override by cloning the agent def (registry copy untouched)', async () => {
    const runner = buildAgentRunner({ config: makeTestConfig() });

    await runner({ agentName: 'researcher', prompt: 'go', model: 'qwen3:8b' });

    const runOpts = orchestratorMocks.run.mock.calls[0]?.[0] as { agent: { model: string } };
    expect(runOpts.agent.model).toBe('qwen3:8b');
    expect(registryMocks.agents.get('researcher')?.model).toBe('qwen2.5:7b');
  });

  it('passes the provided abortSignal through to orchestrator.run', async () => {
    const runner = buildAgentRunner({ config: makeTestConfig() });
    const controller = new AbortController();

    await runner({ agentName: 'researcher', prompt: 'go', abortSignal: controller.signal });

    const runOpts = orchestratorMocks.run.mock.calls[0]?.[0] as { signal: AbortSignal };
    expect(runOpts.signal).toBe(controller.signal);
  });

  it("wires a modelFactory that resolves 'inherit' via the provider's default model", async () => {
    vi.mocked(getDefaultProvider).mockReturnValue(
      makeFakeProviderRow({ defaultModel: 'provider-default' }),
    );
    buildAgentRunner({ config: makeTestConfig() });

    const deps = orchestratorMocks.ctorDeps[0] as {
      modelFactory: (spec: { model: string }) => unknown;
    };
    deps.modelFactory({ model: 'inherit' });

    expect(vi.mocked(createLanguageModel)).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'provider-default' }),
    );
  });

  it('wires a modelFactory that uses an explicit model spec verbatim', async () => {
    buildAgentRunner({ config: makeTestConfig() });

    const deps = orchestratorMocks.ctorDeps[0] as {
      modelFactory: (spec: { model: string }) => unknown;
    };
    deps.modelFactory({ model: 'mistral:7b' });

    expect(vi.mocked(createLanguageModel)).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'mistral:7b' }),
    );
  });

  it('throws from the modelFactory when no provider is configured', () => {
    vi.mocked(getDefaultProvider).mockReturnValue(undefined);
    buildAgentRunner({ config: makeTestConfig() });

    const deps = orchestratorMocks.ctorDeps[0] as {
      modelFactory: (spec: { model: string }) => unknown;
    };
    expect(() => deps.modelFactory({ model: 'inherit' })).toThrow('No provider configured');
  });
});
