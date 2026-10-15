/**
 * orchestrator loop-breaker intervention — verifies the agent path wires
 * wrapToolsWithLoopBreaker around the tools handed to streamText:
 *
 *   - the 3rd identical consecutive execute() is blocked with the synthetic
 *     result and the existing `loop-breaker:fire` event is emitted,
 *   - deps.loopBreaker.intervene === false preserves the old behaviour
 *     (tools execute unguarded, no event).
 *
 * streamText is mocked (same pattern as orchestrator.test.ts); we capture the
 * tools the orchestrator passed in and drive their execute() directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentDef, IAgentRegistry, AgentEvent } from '../types.js';
import type { AgentOrchestratorDeps } from '../orchestrator.js';
import { AgentEventBus } from '../eventBus.js';
import { LOOP_BREAKER_SYNTHETIC_RESULT } from '../../loopBreaker.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAgentDef(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: 'lb-agent',
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

function makeRegistry(): IAgentRegistry {
  return { list: () => [], get: () => undefined, reload: async () => {} };
}

async function* makeStream() {
  yield { type: 'text-delta', textDelta: 'done' } as const;
  yield { type: 'finish', usage: { promptTokens: 1, completionTokens: 1 } } as const;
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

type CapturedTools = Record<string, { execute?: (args: unknown, options: unknown) => unknown }>;

describe('AgentOrchestrator — loop-breaker intervention', () => {
  let eventBus: AgentEventBus;
  let deps: AgentOrchestratorDeps;
  let execSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    eventBus = new AgentEventBus();
    mockStreamText.mockImplementation(() => ({
      fullStream: makeStream(),
      text: Promise.resolve('done'),
    }));
    execSpy = vi.fn((args: unknown) => `probe-ran:${JSON.stringify(args)}`);
    deps = {
      registry: makeRegistry(),
      modelFactory: () => ({} as import('ai').LanguageModel),
      rootTools: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        probe_tool: { description: 'probe', execute: execSpy } as any,
      },
      eventBus,
    };
  });

  async function runAndCaptureTools(depsToUse: AgentOrchestratorDeps): Promise<CapturedTools> {
    const { AgentOrchestrator } = await import('../orchestrator.js');
    const orch = new AgentOrchestrator(depsToUse);
    const ac = new AbortController();
    await orch.run({ agent: makeAgentDef(), userPrompt: 'go', signal: ac.signal });
    const callArgs = mockStreamText.mock.calls[0]![0] as { tools: CapturedTools };
    return callArgs.tools;
  }

  it('passes WRAPPED tools to streamText: 3rd identical call is blocked with the synthetic result', async () => {
    const events: AgentEvent[] = [];
    eventBus.subscribeAll((e) => events.push(e));

    const tools = await runAndCaptureTools(deps);
    const probe = tools['probe_tool']!;

    expect(probe.execute!({ q: 1 }, {})).toBe('probe-ran:{"q":1}');
    expect(probe.execute!({ q: 1 }, {})).toBe('probe-ran:{"q":1}');
    expect(probe.execute!({ q: 1 }, {})).toBe(LOOP_BREAKER_SYNTHETIC_RESULT);
    expect(execSpy).toHaveBeenCalledTimes(2);

    // The existing event still fires so the TUI surfaces the intervention.
    const fired = events.filter((e) => e.type === 'loop-breaker:fire');
    expect(fired).toHaveLength(1);
    expect((fired[0] as { action: string }).action).toBe('force-answer');
    expect((fired[0] as { reason: string }).reason).toContain('probe_tool');
    expect((fired[0] as { reason: string }).reason).toContain('blocked');
  });

  it('different args reset the counter (no block)', async () => {
    const tools = await runAndCaptureTools(deps);
    const probe = tools['probe_tool']!;

    probe.execute!({ q: 1 }, {});
    probe.execute!({ q: 1 }, {});
    probe.execute!({ q: 2 }, {}); // resets
    const next = probe.execute!({ q: 1 }, {});

    expect(next).toBe('probe-ran:{"q":1}');
    expect(execSpy).toHaveBeenCalledTimes(4);
  });

  it('intervene defaults to true when deps.loopBreaker is omitted', async () => {
    const tools = await runAndCaptureTools(deps); // no loopBreaker key at all
    const probe = tools['probe_tool']!;
    probe.execute!({ q: 1 }, {});
    probe.execute!({ q: 1 }, {});
    expect(probe.execute!({ q: 1 }, {})).toBe(LOOP_BREAKER_SYNTHETIC_RESULT);
  });

  it('intervene:false preserves the old emit-only behaviour (no blocking, no event)', async () => {
    const events: AgentEvent[] = [];
    eventBus.subscribeAll((e) => events.push(e));

    const tools = await runAndCaptureTools({ ...deps, loopBreaker: { intervene: false } });
    const probe = tools['probe_tool']!;

    probe.execute!({ q: 1 }, {});
    probe.execute!({ q: 1 }, {});
    const third = probe.execute!({ q: 1 }, {});

    expect(third).toBe('probe-ran:{"q":1}');
    expect(execSpy).toHaveBeenCalledTimes(3);
    expect(events.filter((e) => e.type === 'loop-breaker:fire')).toHaveLength(0);
  });
});
