/**
 * delegationTools — tests for the delegation-runtime upgrades:
 *   1. per-call overrides (model/provider/temperature) + validation
 *   2. continuation (run_id): rehydrate + lineage + error strings
 *   3. background delegation: return-immediately, notification persistence,
 *      delegate:background-complete event
 *   4. send_to_agent on a dead run → error string pointing at continuation
 *
 * Uses a scripted stub orchestrator (mirroring roomConductor.bun.test.ts) —
 * no real AI SDK model is spun up; the orchestrator's own round-loop
 * mechanics are covered in orchestrator.test.ts.
 *
 * Runs under `bun test` (NOT vitest) because it imports the real @uplnk/db
 * which loads bun:sqlite — see the test:bun package script.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { LanguageModel, Tool } from 'ai';

import {
  createConversation,
  createAgentRun,
  getAgentRun,
  getMessages,
  insertMessage,
  type Db,
} from '@uplnk/db';
import { createMigratedTestDb, type MigratedTestDb } from '@uplnk/db/test-helpers';
import { buildDelegationTools } from '../delegationTools.js';
import type {
  AgentDef,
  AgentEvent,
  DelegationContext,
  IAgentOrchestrator,
  RunAgentOptions,
  RunAgentResult,
} from '../types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any>;

const TOOL_OPTS = { toolCallId: 'tc-1', messages: [] };

function makeAgent(name: string, overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: `You are @${name}.`,
    model: 'test-model',
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

function makeRegistry(agents: AgentDef[]) {
  const map = new Map(agents.map((a) => [a.name, a]));
  return {
    list: () => Array.from(map.values()),
    get: (name: string) => map.get(name),
    reload: async () => {},
  };
}

/** Stub orchestrator whose run() promise the test controls. */
function makeStubOrchestrator(result?: RunAgentResult) {
  const calls: RunAgentOptions[] = [];
  let resolveRun!: (r: RunAgentResult) => void;
  let rejectRun!: (e: Error) => void;
  const orch: IAgentOrchestrator = {
    run(opts: RunAgentOptions): Promise<RunAgentResult> {
      calls.push(opts);
      if (result !== undefined) return Promise.resolve(result);
      return new Promise<RunAgentResult>((res, rej) => {
        resolveRun = res;
        rejectRun = rej;
      });
    },
  };
  return {
    orch,
    calls,
    resolve: (r: RunAgentResult) => resolveRun(r),
    reject: (e: Error) => rejectRun(e),
  };
}

/** Yield the microtask queue so detached .then() handlers run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('delegationTools upgrades', () => {
  let handle: MigratedTestDb;
  let db: Db;
  let conversationId: string;
  let events: AgentEvent[];

  beforeEach(() => {
    handle = createMigratedTestDb();
    db = handle.db;
    conversationId = crypto.randomUUID();
    createConversation(db, { id: conversationId, title: 'Delegation test' });
    events = [];
  });

  afterEach(() => {
    handle.close();
  });

  function makeCtx(
    orch: IAgentOrchestrator,
    overrides: Partial<DelegationContext> = {},
  ): DelegationContext {
    const parentAgent = makeAgent('parent-agent', { agents: ['coder'] });
    const coder = makeAgent('coder');
    let seq = 0;
    return {
      self: {
        invocationId: 'parent-inv',
        parentInvocationId: null,
        agent: parentAgent,
        depth: 1,
      },
      rootInvocationId: 'root-inv',
      ancestry: ['parent-agent'],
      state: {},
      nextSeq: () => seq++,
      signal: new AbortController().signal,
      orchestrator: orch,
      registry: makeRegistry([parentAgent, coder]),
      inheritedModel: {} as LanguageModel,
      inheritedTools: {},
      resolveModel: () => ({} as LanguageModel),
      db,
      conversationId,
      ...overrides,
    };
  }

  function buildTools(ctx: DelegationContext): Record<string, AnyTool> {
    return buildDelegationTools(ctx, (ev) => events.push(ev));
  }

  // ── 1. Per-call overrides ───────────────────────────────────────────────────

  it('plumbs model/provider/temperature overrides into orchestrator.run', async () => {
    const stub = makeStubOrchestrator({
      invocationId: 'child-1',
      finalText: 'done',
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    const tools = buildTools(makeCtx(stub.orch));

    const out = await tools['delegate_to_agent']!.execute!(
      { agent: 'coder', prompt: 'build it', model: 'big-model', provider: 'vllm', temperature: 0.2 },
      TOOL_OPTS,
    );

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.overrides).toEqual({
      model: 'big-model',
      provider: 'vllm',
      temperature: 0.2,
    });
    expect(stub.calls[0]!.conversationId).toBe(conversationId);
    // Return contract: summary string + run id
    expect(out).toBe('done\n\n[run_id: child-1]');
  });

  it('ask_agent plumbs overrides too and returns the bare summary', async () => {
    const stub = makeStubOrchestrator({
      invocationId: 'child-2',
      finalText: 'answer',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const tools = buildTools(makeCtx(stub.orch));

    const out = await tools['ask_agent']!.execute!(
      { agent: 'coder', prompt: 'what?', temperature: 0.7 },
      TOOL_OPTS,
    );

    expect(stub.calls[0]!.overrides).toEqual({ temperature: 0.7 });
    expect(out).toBe('answer');
  });

  it('returns a clear error string (never throws) for an unresolvable model override', async () => {
    const stub = makeStubOrchestrator();
    const ctx = makeCtx(stub.orch, {
      resolveModel: () => {
        throw new Error('model "nope-9b" not found in catalog');
      },
    });
    const tools = buildTools(ctx);

    const out = await tools['delegate_to_agent']!.execute!(
      { agent: 'coder', prompt: 'go', model: 'nope-9b' },
      TOOL_OPTS,
    );

    expect(out).toBe(
      'Error: cannot resolve model "nope-9b": model "nope-9b" not found in catalog',
    );
    expect(stub.calls).toHaveLength(0); // never spawned
  });

  // ── 2. Continuation ─────────────────────────────────────────────────────────

  function seedFinishedRun(runId: string, agentName = 'coder', convId = conversationId) {
    createAgentRun(db, {
      id: runId,
      conversationId: convId,
      rootInvocationId: 'old-root',
      agentName,
      depth: 1,
      status: 'completed',
    });
    insertMessage(db, {
      id: `${runId}-m1`,
      conversationId: convId,
      role: 'user',
      content: 'original task',
      agentRunId: runId,
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    insertMessage(db, {
      id: `${runId}-m2`,
      conversationId: convId,
      role: 'assistant',
      content: 'original result',
      agentRunId: runId,
      createdAt: '2026-01-01T00:00:02.000Z',
    });
  }

  it('rehydrates a finished run as history and threads resumedFromRunId lineage', async () => {
    seedFinishedRun('run-old');
    const stub = makeStubOrchestrator({
      invocationId: 'run-new',
      finalText: 'continued',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const tools = buildTools(makeCtx(stub.orch));

    const out = await tools['delegate_to_agent']!.execute!(
      { agent: 'coder', prompt: 'now also add tests', run_id: 'run-old' },
      TOOL_OPTS,
    );

    expect(stub.calls).toHaveLength(1);
    const opts = stub.calls[0]!;
    expect(opts.history).toEqual([
      { role: 'user', content: 'original task' },
      { role: 'assistant', content: 'original result' },
    ]);
    expect(opts.resumedFromRunId).toBe('run-old');
    expect(opts.userPrompt).toBe('now also add tests');
    expect(out).toBe('continued\n\n[run_id: run-new]');
  });

  it('returns an error string when the run id does not exist', async () => {
    const stub = makeStubOrchestrator();
    const tools = buildTools(makeCtx(stub.orch));

    const out = await tools['delegate_to_agent']!.execute!(
      { agent: 'coder', prompt: 'resume', run_id: 'ghost-run' },
      TOOL_OPTS,
    );

    expect(out).toContain('Error: run ghost-run not found');
    expect(stub.calls).toHaveLength(0);
  });

  it('returns an error string when the run belongs to another conversation', async () => {
    const otherConv = crypto.randomUUID();
    createConversation(db, { id: otherConv, title: 'Other' });
    seedFinishedRun('run-foreign', 'coder', otherConv);

    const stub = makeStubOrchestrator();
    const tools = buildTools(makeCtx(stub.orch));

    const out = await tools['delegate_to_agent']!.execute!(
      { agent: 'coder', prompt: 'resume', run_id: 'run-foreign' },
      TOOL_OPTS,
    );

    expect(out).toContain('belongs to a different conversation');
    expect(stub.calls).toHaveLength(0);
  });

  it('returns an error string when the run was a different agent', async () => {
    seedFinishedRun('run-tester', 'tester');

    const stub = makeStubOrchestrator();
    const tools = buildTools(makeCtx(stub.orch));

    const out = await tools['delegate_to_agent']!.execute!(
      { agent: 'coder', prompt: 'resume', run_id: 'run-tester' },
      TOOL_OPTS,
    );

    expect(out).toContain('was a run of @tester, not @coder');
    expect(stub.calls).toHaveLength(0);
  });

  it('returns an error string when continuation is requested without persistence context', async () => {
    const stub = makeStubOrchestrator();
    const ctx = makeCtx(stub.orch);
    delete (ctx as { db?: Db }).db;
    delete (ctx as { conversationId?: string }).conversationId;
    const tools = buildTools(ctx);

    const out = await tools['delegate_to_agent']!.execute!(
      { agent: 'coder', prompt: 'resume', run_id: 'run-x' },
      TOOL_OPTS,
    );

    expect(out).toContain('continuation is unavailable here');
    expect(stub.calls).toHaveLength(0);
  });

  // ── 3. Background delegation ────────────────────────────────────────────────

  it('background: returns immediately with the run id, then persists a notification + emits the completion event', async () => {
    const stub = makeStubOrchestrator(); // deferred — run() stays pending
    const tools = buildTools(makeCtx(stub.orch));

    const out = (await tools['delegate_to_agent']!.execute!(
      { agent: 'coder', prompt: 'long task', background: true },
      TOOL_OPTS,
    )) as string;

    // Returned BEFORE the child resolved, carrying the run id
    const match = /run (\S+)\./.exec(out);
    expect(out).toContain('started in background — run ');
    expect(match).not.toBeNull();
    const runId = match![1]!;

    // agent_runs row persisted up-front as running (makes the run resumable + FK-safe)
    const row = getAgentRun(db, runId);
    expect(row).toBeDefined();
    expect(row!.status).toBe('running');
    expect(row!.agentName).toBe('coder');
    expect(row!.parentInvocationId).toBe('parent-inv');

    // run() received the pre-minted invocation id and a detached signal
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.invocationIdOverride).toBe(runId);
    expect(stub.calls[0]!.signal.aborted).toBe(false);

    // Child completes → notification message + row update + typed event
    stub.resolve({
      invocationId: runId,
      finalText: 'all done',
      usage: { inputTokens: 11, outputTokens: 22 },
    });
    await settle();

    const updated = getAgentRun(db, runId)!;
    expect(updated.status).toBe('completed');
    expect(updated.inputTokens).toBe(11);
    expect(updated.outputTokens).toBe(22);
    expect(updated.endedAt).not.toBeNull();

    const msgs = getMessages(db, conversationId);
    const notif = msgs.find((m) => m.agentRunId === runId);
    expect(notif).toBeDefined();
    expect(notif!.role).toBe('assistant');
    expect(notif!.senderAgentName).toBe('coder');
    expect(notif!.content).toBe('[coder finished] all done');

    const done = events.find((e) => e.type === 'delegate:background-complete');
    expect(done).toBeDefined();
    if (done?.type === 'delegate:background-complete') {
      expect(done.childInvocationId).toBe(runId);
      expect(done.childAgent).toBe('coder');
      expect(done.status).toBe('completed');
      expect(done.summary).toBe('all done');
      expect(done.notification).toBe('[coder finished] all done');
      expect(done.conversationId).toBe(conversationId);
      expect(done.messageId).toBe(notif!.id);
    }
  });

  it('background: an errored child persists a failure notification and emits status errored', async () => {
    const stub = makeStubOrchestrator();
    const tools = buildTools(makeCtx(stub.orch));

    const out = (await tools['delegate_to_agent']!.execute!(
      { agent: 'coder', prompt: 'doomed task', background: true },
      TOOL_OPTS,
    )) as string;
    const runId = /run (\S+)\./.exec(out)![1]!;

    stub.reject(new Error('model exploded'));
    await settle();

    expect(getAgentRun(db, runId)!.status).toBe('errored');
    expect(getAgentRun(db, runId)!.errorMessage).toBe('model exploded');

    const notif = getMessages(db, conversationId).find((m) => m.agentRunId === runId);
    expect(notif!.content).toBe('[coder failed] model exploded');

    const done = events.find((e) => e.type === 'delegate:background-complete');
    expect(done).toBeDefined();
    if (done?.type === 'delegate:background-complete') {
      expect(done.status).toBe('errored');
      expect(done.summary).toBe('model exploded');
    }
  });

  it('background without persistence context still runs and emits the event with null ids', async () => {
    const stub = makeStubOrchestrator();
    const ctx = makeCtx(stub.orch);
    delete (ctx as { db?: Db }).db;
    delete (ctx as { conversationId?: string }).conversationId;
    const tools = buildTools(ctx);

    const out = (await tools['delegate_to_agent']!.execute!(
      { agent: 'coder', prompt: 'task', background: true },
      TOOL_OPTS,
    )) as string;
    expect(out).toContain('started in background — run ');

    stub.resolve({ invocationId: 'x', finalText: 'ok', usage: { inputTokens: 0, outputTokens: 0 } });
    await settle();

    const done = events.find((e) => e.type === 'delegate:background-complete');
    expect(done).toBeDefined();
    if (done?.type === 'delegate:background-complete') {
      expect(done.conversationId).toBeNull();
      expect(done.messageId).toBeNull();
    }
  });

  // ── 4. send_to_agent ────────────────────────────────────────────────────────

  it('send_to_agent on a run that is not active returns an error string pointing at continuation', async () => {
    const stub = makeStubOrchestrator();
    const tools = buildTools(makeCtx(stub.orch));

    const out = await tools['send_to_agent']!.execute!(
      { run_id: 'dead-run', message: 'are you there?' },
      TOOL_OPTS,
    );

    expect(out).toBe(
      'Error: run dead-run is not active. To continue a finished run, call delegate_to_agent with run_id=dead-run.',
    );
  });

  it('send_to_agent is registered alongside the delegation tools', () => {
    const stub = makeStubOrchestrator();
    const tools = buildTools(makeCtx(stub.orch));
    expect(Object.keys(tools).sort()).toEqual([
      'ask_agent',
      'delegate_to_agent',
      'send_to_agent',
      'state_get',
      'state_set',
    ]);
  });
});
