/**
 * RoomConductor — integration-style tests with a scripted stub orchestrator.
 *
 * The stub lets each test dictate:
 *   - what finalText each named invocation produces
 *   - which room tool (handoff_to_agent / return_to_user / spawn_agent) that
 *     invocation "calls" by mutating the RoomSignal before returning
 *
 * We don't spin up a real AI SDK model — that's orchestrator.test.ts's job.
 * Here we verify conductor behaviour: floor-passing, budgets, ping-pong,
 * exactly-one room:turn-end, DB persistence of messages and agent_runs rows.
 *
 * Runs under `bun test` (NOT vitest) because it imports the real @uplnk/db
 * which loads bun:sqlite. Vitest's Node-based worker pool cannot resolve the
 * bun: scheme, so this file is excluded from vitest config and run by Bun's
 * native test runner via the `test:bun` package script.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ulid } from 'ulid';
import { eq } from 'drizzle-orm';

import {
  conversations,
  messages,
  agentRuns,
  ephemeralAgents,
  type Db,
} from '@uplnk/db';
import { createMigratedTestDb } from '@uplnk/db/test-helpers';
import { AgentEventBus } from '../eventBus.js';
import type {
  AgentDef,
  AgentEvent,
  IAgentOrchestrator,
  RunAgentOptions,
  RunAgentResult,
} from '../types.js';
import { RoomConductor } from '../roomConductor.js';
import { EphemeralRegistry } from '../ephemeralRegistry.js';
import type { RoomSignal } from '../roomTools.js';

function makeAgent(name: string, overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: `You are @${name}.`,
    model: 'inherit',
    maxDepth: 3,
    memory: 'none',
    color: 'cyan',
    icon: '🤖',
    userInvocable: true,
    maxTurns: 10,
    timeoutMs: 60_000,
    source: 'builtin',
    sourcePath: `/agents/${name}.md`,
    ...overrides,
  };
}

interface StubScript {
  /** Map invocation ordinal (0-indexed) to script behaviour. */
  sequence: Array<{
    expectedAgent: string;
    finalText: string;
    signal?: (s: RoomSignal) => void;
    usage?: { inputTokens: number; outputTokens: number };
    throwErr?: string;
  }>;
}

function makeStubOrchestrator(
  script: StubScript,
  bus: AgentEventBus,
): IAgentOrchestrator & { callCount: number; toolNames: string[][] } {
  let callCount = 0;
  const toolNames: string[][] = [];

  return {
    callCount,
    toolNames,
    async run(opts: RunAgentOptions): Promise<RunAgentResult> {
      const step = script.sequence[callCount];
      if (step === undefined) {
        throw new Error(`Stub: no scripted step for call #${callCount}`);
      }
      if (step.expectedAgent !== opts.agent.name) {
        throw new Error(
          `Stub: expected call #${callCount} to be @${step.expectedAgent}, got @${opts.agent.name}`,
        );
      }
      toolNames.push(Object.keys(opts.extraTools ?? {}));
      callCount++;
      (this as { callCount: number }).callCount = callCount;

      const invocationId = ulid();
      const rootInvocationId = opts.rootInvocationIdOverride ?? invocationId;

      bus.emitEvent({
        type: 'agent:start',
        invocationId,
        rootInvocationId,
        parentInvocationId: null,
        agentName: opts.agent.name,
        depth: 1,
        seq: 0,
        ts: Date.now(),
        userPrompt: opts.userPrompt,
        model: 'stub',
      } as AgentEvent);

      if (step.throwErr !== undefined) {
        const err = new Error(step.throwErr);
        bus.emitEvent({
          type: 'agent:error',
          invocationId,
          rootInvocationId,
          parentInvocationId: null,
          agentName: opts.agent.name,
          depth: 1,
          seq: 1,
          ts: Date.now(),
          error: { code: 'TEST', message: err.message },
        } as AgentEvent);
        throw err;
      }

      if (step.signal && opts.extraTools) {
        // Reach into the RoomSignal via one of the injected tools. roomTools
        // closes over the signal; simulate by looking it up through the
        // handoff tool's execute closure is impossible — so we use a back
        // channel: each tool's `execute` is mocked here by the step callback
        // receiving the signal directly.
        // Instead, we reach the signal via calling the actual tool execute(),
        // which mutates the shared signal. We look up the tool by name.
        await step.signal(opts.extraTools as unknown as RoomSignal);
      }

      const usage = step.usage ?? { inputTokens: 0, outputTokens: 0 };
      bus.emitEvent({
        type: 'agent:end',
        invocationId,
        rootInvocationId,
        parentInvocationId: null,
        agentName: opts.agent.name,
        depth: 1,
        seq: 2,
        ts: Date.now(),
        finalText: step.finalText,
        usage,
        durationMs: 10,
      } as AgentEvent);

      return { invocationId, finalText: step.finalText, usage };
    },
  };
}

/**
 * Helper to drive a RoomSignal from a script step. Because the stub doesn't
 * actually execute the AI SDK tools, we need a different back-channel. The
 * conductor constructs the room tools and passes them as extraTools. Each
 * tool closes over the same RoomSignal. So we invoke a tool's execute()
 * directly from the stub step.
 */
function signalHandoff(to: string, message: string) {
  return async (tools: RoomSignal): Promise<void> => {
    // `tools` here is actually the Record<string, Tool> we passed in — we
    // typed it as RoomSignal in the step for ergonomic reasons but it's
    // really the tool bag. Use `as unknown as` to grab the handoff tool.
    const bag = tools as unknown as Record<string, { execute: (args: unknown) => Promise<unknown> }>;
    await bag['handoff_to_agent']!.execute({ to, message });
  };
}

function signalReturn() {
  return async (tools: RoomSignal): Promise<void> => {
    const bag = tools as unknown as Record<string, { execute: (args: unknown) => Promise<unknown> }>;
    await bag['return_to_user']!.execute({});
  };
}

function signalSpawn(name: string, systemPrompt: string, firstMessage: string) {
  return async (tools: RoomSignal): Promise<void> => {
    const bag = tools as unknown as Record<string, { execute: (args: unknown) => Promise<unknown> }>;
    await bag['spawn_agent']!.execute({ name, systemPrompt, firstMessage });
  };
}

describe('RoomConductor', () => {
  let db: Db;
  let closeDb: () => void;
  let bus: AgentEventBus;
  let conversationId: string;
  const events: AgentEvent[] = [];

  beforeEach(() => {
    const handle = createMigratedTestDb();
    db = handle.db;
    closeDb = handle.close;

    conversationId = 'conv-1';
    db
      .insert(conversations)
      .values({ id: conversationId, title: 'test' })
      .run();

    bus = new AgentEventBus();
    bus.setMaxListeners(50);
    events.length = 0;
    bus.subscribeAll((ev) => events.push(ev));
  });

  afterEach(() => {
    closeDb();
  });

  function makeRegistry(agents: AgentDef[]): EphemeralRegistry {
    const base = {
      list: () => agents,
      get: (name: string) => agents.find((a) => a.name === name),
      reload: async () => {},
    };
    return new EphemeralRegistry({ base, conversationId, db });
  }

  function makeConductor(
    orch: IAgentOrchestrator,
    reg: EphemeralRegistry,
    toolNames: string[] = [],
    budgetOverride = {},
  ): RoomConductor {
    return new RoomConductor({
      orchestrator: orch,
      registry: reg,
      eventBus: bus,
      conversationId,
      callerEffectiveToolNames: new Set(toolNames),
      budget: budgetOverride,
      db,
    });
  }

  it('runs a single addressee and ends cleanly with no handoff', async () => {
    const coder = makeAgent('coder');
    const reg = makeRegistry([coder]);
    const orch = makeStubOrchestrator(
      { sequence: [{ expectedAgent: 'coder', finalText: 'hello from coder' }] },
      bus,
    );
    const conductor = makeConductor(orch, reg);
    const result = await conductor.start({
      addressees: ['coder'],
      cc: [],
      userText: 'say hi',
      history: [],
    });
    expect(result.reason).toBe('done');
    expect(result.handoffs).toBe(0);
    const turnEnds = events.filter((e) => e.type === 'room:turn-end');
    expect(turnEnds).toHaveLength(1);
  });

  it('chains a single handoff: coder → planner → done', async () => {
    const coder = makeAgent('coder');
    const planner = makeAgent('planner');
    const reg = makeRegistry([coder, planner]);
    const orch = makeStubOrchestrator(
      {
        sequence: [
          {
            expectedAgent: 'coder',
            finalText: 'let me hand off',
            signal: signalHandoff('planner', 'can you brainstorm?'),
          },
          { expectedAgent: 'planner', finalText: 'here is a plan' },
        ],
      },
      bus,
    );
    const conductor = makeConductor(orch, reg);
    const result = await conductor.start({
      addressees: ['coder'],
      cc: ['planner'],
      userText: 'brainstorm features',
      history: [],
    });
    expect(result.reason).toBe('done');
    expect(result.handoffs).toBe(1);

    const handoffs = events.filter((e) => e.type === 'room:handoff');
    expect(handoffs).toHaveLength(1);
    if (handoffs[0]!.type === 'room:handoff') {
      expect(handoffs[0]!.from).toBe('coder');
      expect(handoffs[0]!.to).toBe('planner');
    }

    const turnEnds = events.filter((e) => e.type === 'room:turn-end');
    expect(turnEnds).toHaveLength(1);
  });

  it('return_to_user stops the loop', async () => {
    const coder = makeAgent('coder');
    const reg = makeRegistry([coder]);
    const orch = makeStubOrchestrator(
      {
        sequence: [
          {
            expectedAgent: 'coder',
            finalText: 'ok we are done',
            signal: signalReturn(),
          },
        ],
      },
      bus,
    );
    const conductor = makeConductor(orch, reg);
    const result = await conductor.start({
      addressees: ['coder'],
      cc: [],
      userText: 'wrap up',
      history: [],
    });
    expect(result.reason).toBe('done');
  });

  it('stops at maxHandoffsPerUserTurn budget', async () => {
    const coder = makeAgent('coder');
    const planner = makeAgent('planner');
    const reg = makeRegistry([coder, planner]);
    // Infinite handoffs between coder and planner — would run forever without
    // budget. Each turn uses unique vocabulary so the ping-pong detector
    // (Jaccard ≥ 0.6 on normalized tokens) never trips.
    const uniqueWords = [
      'alpha beta gamma delta',
      'zeta eta theta iota',
      'kappa lambda mu nu',
      'xi omicron pi rho',
      'sigma tau upsilon phi',
      'chi psi omega sampi',
      'digamma qoppa stigma',
      'vav heth teth waw',
      'aleph bet gimel dalet',
      'he zayin chet tet',
    ];
    const sequence = [];
    for (let i = 0; i < 10; i++) {
      const next = i % 2 === 0 ? 'planner' : 'coder';
      sequence.push({
        expectedAgent: i % 2 === 0 ? 'coder' : 'planner',
        finalText: uniqueWords[i]!,
        signal: signalHandoff(next, `next please ${i}`),
      });
    }
    const orch = makeStubOrchestrator({ sequence }, bus);
    const conductor = makeConductor(orch, reg, [], { maxHandoffsPerUserTurn: 3 });
    const result = await conductor.start({
      addressees: ['coder'],
      cc: [],
      userText: 'loop forever',
      history: [],
    });
    expect(result.reason).toBe('budget');
    expect(result.handoffs).toBe(3);
    const turnEnds = events.filter((e) => e.type === 'room:turn-end');
    expect(turnEnds).toHaveLength(1);
  });

  it('detects ping-pong between two agents producing similar messages', async () => {
    const coder = makeAgent('coder');
    const planner = makeAgent('planner');
    const reg = makeRegistry([coder, planner]);
    // A → B → A where first & third share lots of tokens → Jaccard ≥ 0.6
    const repeat = 'please review this plan for features of the application carefully';
    const orch = makeStubOrchestrator(
      {
        sequence: [
          {
            expectedAgent: 'coder',
            finalText: repeat,
            signal: signalHandoff('planner', 'over to you'),
          },
          {
            expectedAgent: 'planner',
            finalText: 'sure here is a reply different',
            signal: signalHandoff('coder', 'back to you'),
          },
          {
            expectedAgent: 'coder',
            finalText: repeat,
            signal: signalHandoff('planner', 'again'),
          },
        ],
      },
      bus,
    );
    const conductor = makeConductor(orch, reg);
    const result = await conductor.start({
      addressees: ['coder'],
      cc: [],
      userText: 'brainstorm',
      history: [],
    });
    expect(result.reason).toBe('ping-pong');
    const pp = events.filter((e) => e.type === 'room:ping-pong');
    expect(pp.length).toBeGreaterThanOrEqual(1);
  });

  it('persists visible messages + agent_runs rows', async () => {
    const coder = makeAgent('coder');
    const planner = makeAgent('planner');
    const reg = makeRegistry([coder, planner]);
    const orch = makeStubOrchestrator(
      {
        sequence: [
          {
            expectedAgent: 'coder',
            finalText: 'hand off time',
            signal: signalHandoff('planner', 'your turn'),
            usage: { inputTokens: 50, outputTokens: 10 },
          },
          {
            expectedAgent: 'planner',
            finalText: 'plan delivered',
            usage: { inputTokens: 20, outputTokens: 30 },
          },
        ],
      },
      bus,
    );
    const conductor = makeConductor(orch, reg);
    await conductor.start({
      addressees: ['coder'],
      cc: ['planner'],
      userText: 'make a plan',
      history: [],
    });

    const rows = db.select().from(messages).where(eq(messages.conversationId, conversationId)).all();
    // 1 user row + 2 assistant rows (coder, planner)
    expect(rows).toHaveLength(3);
    const assistants = rows.filter((r) => r.role === 'assistant');
    const senders = assistants.map((a) => a.senderAgentName).sort();
    expect(senders).toEqual(['coder', 'planner']);

    const runs = db.select().from(agentRuns).all();
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === 'completed')).toBe(true);
  });

  it('spawn_agent creates an ephemeral and hands the floor to it', async () => {
    const coder = makeAgent('coder');
    const reg = makeRegistry([coder]);
    const orch = makeStubOrchestrator(
      {
        sequence: [
          {
            expectedAgent: 'coder',
            finalText: 'spawning a reviewer',
            signal: signalSpawn(
              'reviewer-x',
              'You are a code reviewer.',
              'please review this diff',
            ),
          },
          { expectedAgent: 'reviewer-x', finalText: 'lgtm' },
        ],
      },
      bus,
    );
    const conductor = makeConductor(orch, reg);
    const result = await conductor.start({
      addressees: ['coder'],
      cc: [],
      userText: 'get a review',
      history: [],
    });
    expect(result.reason).toBe('done');
    expect(result.spawns).toBe(1);

    const eph = db.select().from(ephemeralAgents).all();
    expect(eph).toHaveLength(1);
    expect(eph[0]!.name).toBe('reviewer-x');

    const spawnEvents = events.filter((e) => e.type === 'room:spawn');
    expect(spawnEvents).toHaveLength(1);
  });

  it('emits exactly one room:turn-end even when the orchestrator throws', async () => {
    const coder = makeAgent('coder');
    const reg = makeRegistry([coder]);
    const orch = makeStubOrchestrator(
      {
        sequence: [{ expectedAgent: 'coder', finalText: '', throwErr: 'boom' }],
      },
      bus,
    );
    const conductor = makeConductor(orch, reg);
    const result = await conductor.start({
      addressees: ['coder'],
      cc: [],
      userText: 'trigger error',
      history: [],
    });
    expect(result.reason).toBe('error');
    const turnEnds = events.filter((e) => e.type === 'room:turn-end');
    expect(turnEnds).toHaveLength(1);
  });
});
