/**
 * buildDelegationTools — constructs per-invocation delegation + state tools.
 *
 * Five tools are produced, each closing over a DelegationContext:
 *   - delegate_to_agent  (full handoff — model should stop after returning;
 *                         supports per-call overrides, continuation via run_id,
 *                         and detached background runs)
 *   - ask_agent          (call-and-return — model continues after result;
 *                         supports per-call overrides)
 *   - send_to_agent      (enqueue a follow-up message for a run that is still
 *                         executing in this process)
 *   - state_get          (read shared state)
 *   - state_set          (write shared state)
 *
 * Only the string summary is returned to the parent LLM — the child's full
 * transcript never leaks into the parent's context window.
 *
 * Validation added by the delegation upgrades (unknown model override, bad
 * run_id, dead run) returns clear error STRINGS to the calling model rather
 * than throwing — the model can read them and correct course.
 */

import { tool } from 'ai';
import type { CoreMessage, Tool } from 'ai';
import { z } from 'zod';
import { ulid } from 'ulid';
import {
  createAgentRun,
  getAgentRun,
  getAgentRunMessages,
  insertMessage,
  touchConversation,
  updateAgentRun,
} from '@uplnk/db';
import type {
  AgentDef,
  AgentRunOverrides,
  DelegationContext,
  RunAgentOptions,
} from './types.js';
import { trimMessagesForContext } from '../contextBudget.js';
import { enqueueMessageForRun, isRunActive } from './orchestrator.js';

const GLOBAL_MAX_DEPTH = 5;

/**
 * Conservative context window for the continuation pre-trim — matches the
 * orchestrator's DEFAULT_CONTEXT_WINDOW. The orchestrator applies a second,
 * model-specific trimMessagesForContext pass at run() time; this pre-trim
 * keeps a pathological multi-megabyte transcript from ever being carried.
 */
const CONTINUATION_CONTEXT_WINDOW = 8192;

function enforceDepth(ctx: DelegationContext, targetAgent: string): void {
  if (ctx.self.depth >= GLOBAL_MAX_DEPTH) {
    throw new Error(
      `Delegation depth limit (${GLOBAL_MAX_DEPTH}) reached. Cannot delegate to @${targetAgent}.`,
    );
  }
  if (ctx.self.depth > ctx.self.agent.maxDepth) {
    throw new Error(
      `Agent @${ctx.self.agent.name} has maxDepth=${ctx.self.agent.maxDepth} and is already at depth ${ctx.self.depth}. Cannot delegate to @${targetAgent}.`,
    );
  }
}

function enforceNoLoop(ctx: DelegationContext, targetAgent: string): void {
  if (ctx.ancestry.includes(targetAgent)) {
    throw new Error(
      `Cycle detected: @${targetAgent} is already in the delegation chain [${ctx.ancestry.join(' → ')}].`,
    );
  }
}

function resolveAllowedAgents(ctx: DelegationContext): string[] {
  const { agents } = ctx.self.agent;
  if (!agents || agents.length === 0) return [];

  const allNames = ctx.registry.list().map((a) => a.name);
  const allowed = agents[0] === '*' ? allNames : agents;

  // Remove ancestors to prevent cycles
  return allowed.filter((n) => !ctx.ancestry.includes(n));
}

/** Collect the per-call override args into an AgentRunOverrides, or undefined when none set. */
function buildOverrides(args: {
  model?: string | undefined;
  provider?: string | undefined;
  temperature?: number | undefined;
}): AgentRunOverrides | undefined {
  if (args.model === undefined && args.provider === undefined && args.temperature === undefined) {
    return undefined;
  }
  return {
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.provider !== undefined ? { provider: args.provider } : {}),
    ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
  };
}

/**
 * Validate a model/provider override through the SAME resolution path the
 * orchestrator uses (ctx.resolveModel === its modelFactory). Returns an error
 * string for the calling model, or null when the override resolves.
 */
function validateModelOverride(
  ctx: DelegationContext,
  agentDef: AgentDef,
  overrides: AgentRunOverrides,
): string | null {
  if (overrides.model === undefined && overrides.provider === undefined) return null;
  // No resolver injected (older orchestrators / test stubs): run() will
  // resolve through the identical factory anyway — nothing extra to check.
  if (ctx.resolveModel === undefined) return null;
  const model = overrides.model ?? agentDef.model;
  const provider = overrides.provider ?? agentDef.provider;
  try {
    ctx.resolveModel({ model, ...(provider !== undefined ? { provider } : {}) });
    return null;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `Error: cannot resolve model "${model}"${provider !== undefined ? ` on provider "${provider}"` : ''}: ${detail}`;
  }
}

/**
 * Continuation: load + rehydrate a prior finished run's transcript.
 * Returns the trimmed CoreMessage history, or an error string for the model.
 */
function loadContinuation(
  ctx: DelegationContext,
  targetAgent: string,
  runId: string,
): CoreMessage[] | string {
  if (isRunActive(runId)) {
    return `Error: run ${runId} is still active. Use send_to_agent to message a live run — continuation via run_id is for finished runs.`;
  }
  if (ctx.db === undefined || ctx.conversationId === undefined) {
    return 'Error: continuation is unavailable here — this context has no conversation persistence.';
  }
  const run = getAgentRun(ctx.db, runId);
  if (run === undefined) {
    return `Error: run ${runId} not found. Only persisted runs (background delegations and room-mode runs) can be resumed.`;
  }
  if (run.conversationId !== ctx.conversationId) {
    return `Error: run ${runId} belongs to a different conversation and cannot be resumed here.`;
  }
  if (run.agentName !== targetAgent) {
    return `Error: run ${runId} was a run of @${run.agentName}, not @${targetAgent}. Delegate to @${run.agentName} to resume it.`;
  }

  const rehydrated: CoreMessage[] = [];
  for (const m of getAgentRunMessages(ctx.db, runId)) {
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') continue;
    rehydrated.push({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content ?? '',
    });
  }

  // Same trimmer as everywhere else (lib/contextBudget.ts). The orchestrator
  // re-trims against the live model window at run(); this pass bounds the
  // rehydrated transcript itself.
  return trimMessagesForContext(rehydrated, {
    contextWindow: CONTINUATION_CONTEXT_WINDOW,
    inputBudgetRatio: 0.85,
    protectedIndices: [],
  }).messages;
}

// Per-call override params shared by delegate_to_agent and ask_agent.
// Hard limits (maxTurns / timeoutMs / depth) deliberately have NO override —
// they always come from the agent definition.
const OVERRIDE_PARAMS = {
  model: z
    .string()
    .optional()
    .describe('Override the target agent\'s model for this call only (e.g. "qwen2.5:14b").'),
  provider: z
    .string()
    .optional()
    .describe('Override the provider used to resolve the model for this call only.'),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe('Override the sampling temperature (0–2) for this call only.'),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildDelegationTools(ctx: DelegationContext, emit: (event: import('./types.js').AgentEvent) => void): Record<string, Tool<any, any>> {
  const allowedAgents = resolveAllowedAgents(ctx);

  // If no delegation is possible, return only state tools
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, Tool<any, any>> = {};

  // Shared parent block for child run options.
  const parentOpts = (): NonNullable<RunAgentOptions['parent']> => ({
    invocationId: ctx.self.invocationId,
    depth: ctx.self.depth,
    ancestry: ctx.ancestry,
    rootInvocationId: ctx.rootInvocationId,
    state: ctx.state,
    nextSeq: ctx.nextSeq,
    inheritedModel: ctx.inheritedModel,
    inheritedTools: ctx.inheritedTools,
  });

  /**
   * Background delegation: spawn detached, return the run id immediately.
   * On completion or error: persist a notification message into the parent
   * conversation and emit `delegate:background-complete` on the bus.
   *
   * Background runs die with the process — accepted, per the locked
   * "Daemon mode: NO" decision (plan §7.1). Everything here stays in-process:
   * no daemon, no on-disk job state, no replay buffer.
   */
  const startBackgroundRun = (
    agentDef: AgentDef,
    prompt: string,
    baseOpts: Omit<RunAgentOptions, 'signal'>,
    resumedFromRunId: string | undefined,
  ): string => {
    const childInvocationId = ulid();

    // Persist a 'running' agent_runs row up-front when we can: the completion
    // notification's agent_run_id FK must resolve, and the row is what makes
    // the background run resumable via run_id later. Best-effort, matching
    // roomConductor's persistence posture.
    let runRowPersisted = false;
    if (ctx.db !== undefined && ctx.conversationId !== undefined) {
      try {
        createAgentRun(ctx.db, {
          id: childInvocationId,
          conversationId: ctx.conversationId,
          rootInvocationId: ctx.rootInvocationId,
          parentInvocationId: ctx.self.invocationId,
          agentName: agentDef.name,
          depth: ctx.self.depth + 1,
          ancestryJson: JSON.stringify([...ctx.ancestry, agentDef.name]),
          model: baseOpts.overrides?.model ?? agentDef.model,
          status: 'running',
          ...(resumedFromRunId !== undefined ? { resumedFromRunId } : {}),
        });
        runRowPersisted = true;
      } catch {
        // Non-fatal — the run itself and the completion event don't depend on it.
      }
    }

    emit({
      type: 'delegate:spawn',
      invocationId: ctx.self.invocationId,
      rootInvocationId: ctx.rootInvocationId,
      parentInvocationId: ctx.self.invocationId,
      agentName: ctx.self.agent.name,
      depth: ctx.self.depth,
      seq: ctx.nextSeq(),
      ts: Date.now(),
      childInvocationId,
      childAgent: agentDef.name,
      mode: 'delegate',
      prompt,
    });

    const finish = (
      status: 'completed' | 'errored',
      summary: string,
      usage?: { inputTokens: number; outputTokens: number },
    ): void => {
      const label = status === 'completed' ? 'finished' : 'failed';
      const notification = `[${agentDef.name} ${label}] ${summary}`;

      // (a) Persist the notification into the parent conversation.
      let messageId: string | null = null;
      if (ctx.db !== undefined && ctx.conversationId !== undefined) {
        try {
          if (runRowPersisted) {
            updateAgentRun(ctx.db, childInvocationId, {
              status,
              ...(status === 'errored' ? { errorMessage: summary } : {}),
              ...(usage !== undefined
                ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
                : {}),
              endedAt: new Date().toISOString(),
            });
          }
          const msgId = ulid();
          insertMessage(ctx.db, {
            id: msgId,
            conversationId: ctx.conversationId,
            role: 'assistant',
            content: notification,
            senderAgentName: agentDef.name,
            ...(runRowPersisted ? { agentRunId: childInvocationId } : {}),
          });
          touchConversation(ctx.db, ctx.conversationId);
          messageId = msgId;
        } catch {
          // Best-effort — the bus event below still fires.
        }
      }

      // (b) Typed completion event on the bus.
      emit({
        type: 'delegate:background-complete',
        invocationId: ctx.self.invocationId,
        rootInvocationId: ctx.rootInvocationId,
        parentInvocationId: ctx.self.parentInvocationId,
        agentName: ctx.self.agent.name,
        depth: ctx.self.depth,
        seq: ctx.nextSeq(),
        ts: Date.now(),
        childInvocationId,
        childAgent: agentDef.name,
        status,
        summary,
        notification,
        conversationId: ctx.conversationId ?? null,
        messageId,
      });
    };

    // Detached: deliberately NOT tied to the parent's per-turn abort signal —
    // the parent turn ending must not kill the background run. The agent's
    // own timeoutMs still applies inside run(). Both promise branches are
    // handled, so no unhandled rejection can escape.
    const detached = new AbortController();
    void ctx.orchestrator
      .run({
        ...baseOpts,
        signal: detached.signal,
        invocationIdOverride: childInvocationId,
      })
      .then(
        (result) => { finish('completed', result.finalText, result.usage); },
        (err: unknown) => {
          finish('errored', err instanceof Error ? err.message : String(err));
        },
      );

    return `Delegation to @${agentDef.name} started in background — run ${childInvocationId}. A notification will be posted to this conversation when it finishes.`;
  };

  if (allowedAgents.length > 0) {
    const agentEnum = z.enum(allowedAgents as [string, ...string[]]);

    // ── delegate_to_agent ───────────────────────────────────────────────────
    tools['delegate_to_agent'] = tool({
      description: `Hand off the current task to a specialist agent. Control transfers — you should wrap up after the delegate returns. Allowed targets: ${allowedAgents.join(', ')}`,
      parameters: z.object({
        agent: agentEnum.describe('Name of the agent to delegate to.'),
        prompt: z.string().describe('Task description for the delegate. Be specific.'),
        ...OVERRIDE_PARAMS,
        run_id: z
          .string()
          .optional()
          .describe('ULID of a prior finished run of this agent to resume. Its transcript is rehydrated and your prompt continues it.'),
        background: z
          .boolean()
          .optional()
          .describe('Run detached: returns immediately with the run id; a notification is posted to the conversation when the run finishes. Background runs die with the process.'),
      }),
      execute: async ({ agent: agentName, prompt, model, provider, temperature, run_id, background }) => {
        enforceDepth(ctx, agentName);
        enforceNoLoop(ctx, agentName);

        const agentDef = ctx.registry.get(agentName);
        if (agentDef === undefined) {
          throw new Error(`Agent @${agentName} not found in registry.`);
        }

        const overrides = buildOverrides({ model, provider, temperature });
        if (overrides !== undefined) {
          const overrideError = validateModelOverride(ctx, agentDef, overrides);
          if (overrideError !== null) return overrideError;
        }

        let history: CoreMessage[] | undefined;
        if (run_id !== undefined) {
          const loaded = loadContinuation(ctx, agentName, run_id);
          if (typeof loaded === 'string') return loaded;
          history = loaded;
        }

        const baseOpts: Omit<RunAgentOptions, 'signal'> = {
          agent: agentDef,
          userPrompt: prompt,
          ...(history !== undefined ? { history } : {}),
          ...(overrides !== undefined ? { overrides } : {}),
          ...(run_id !== undefined ? { resumedFromRunId: run_id } : {}),
          ...(ctx.conversationId !== undefined ? { conversationId: ctx.conversationId } : {}),
          parent: parentOpts(),
        };

        if (background === true) {
          return startBackgroundRun(agentDef, prompt, baseOpts, run_id);
        }

        const result = await ctx.orchestrator.run({
          ...baseOpts,
          signal: ctx.signal,
        });

        emit({
          type: 'delegate:spawn',
          invocationId: ctx.self.invocationId,
          rootInvocationId: ctx.rootInvocationId,
          parentInvocationId: ctx.self.invocationId,
          agentName: ctx.self.agent.name,
          depth: ctx.self.depth,
          seq: ctx.nextSeq(),
          ts: Date.now(),
          childInvocationId: result.invocationId,
          childAgent: agentName,
          mode: 'delegate',
          prompt,
        });

        emit({
          type: 'delegate:return',
          invocationId: ctx.self.invocationId,
          rootInvocationId: ctx.rootInvocationId,
          parentInvocationId: ctx.self.invocationId,
          agentName: ctx.self.agent.name,
          depth: ctx.self.depth,
          seq: ctx.nextSeq(),
          ts: Date.now(),
          childInvocationId: result.invocationId,
          childAgent: agentName,
          mode: 'delegate',
          summary: result.finalText,
        });

        // Only the summary goes back to the parent LLM — plus the run id so
        // the model can resume (run_id) or extend (send_to_agent) it later.
        return `${result.finalText}\n\n[run_id: ${result.invocationId}]`;
      },
    });

    // ── ask_agent ───────────────────────────────────────────────────────────
    tools['ask_agent'] = tool({
      description: `Call a specialist agent and return here with the result. You keep control and can continue after receiving the answer. Allowed targets: ${allowedAgents.join(', ')}`,
      parameters: z.object({
        agent: agentEnum.describe('Name of the agent to ask.'),
        prompt: z.string().describe('Question or task for the agent. Be specific.'),
        ...OVERRIDE_PARAMS,
      }),
      execute: async ({ agent: agentName, prompt, model, provider, temperature }) => {
        enforceDepth(ctx, agentName);
        enforceNoLoop(ctx, agentName);

        const agentDef = ctx.registry.get(agentName);
        if (agentDef === undefined) {
          throw new Error(`Agent @${agentName} not found in registry.`);
        }

        const overrides = buildOverrides({ model, provider, temperature });
        if (overrides !== undefined) {
          const overrideError = validateModelOverride(ctx, agentDef, overrides);
          if (overrideError !== null) return overrideError;
        }

        const result = await ctx.orchestrator.run({
          agent: agentDef,
          userPrompt: prompt,
          ...(overrides !== undefined ? { overrides } : {}),
          ...(ctx.conversationId !== undefined ? { conversationId: ctx.conversationId } : {}),
          parent: parentOpts(),
          signal: ctx.signal,
        });

        emit({
          type: 'delegate:spawn',
          invocationId: ctx.self.invocationId,
          rootInvocationId: ctx.rootInvocationId,
          parentInvocationId: ctx.self.invocationId,
          agentName: ctx.self.agent.name,
          depth: ctx.self.depth,
          seq: ctx.nextSeq(),
          ts: Date.now(),
          childInvocationId: result.invocationId,
          childAgent: agentName,
          mode: 'ask',
          prompt,
        });

        emit({
          type: 'delegate:return',
          invocationId: ctx.self.invocationId,
          rootInvocationId: ctx.rootInvocationId,
          parentInvocationId: ctx.self.invocationId,
          agentName: ctx.self.agent.name,
          depth: ctx.self.depth,
          seq: ctx.nextSeq(),
          ts: Date.now(),
          childInvocationId: result.invocationId,
          childAgent: agentName,
          mode: 'ask',
          summary: result.finalText,
        });

        return result.finalText;
      },
    });

    // ── send_to_agent ───────────────────────────────────────────────────────
    tools['send_to_agent'] = tool({
      description: 'Send a follow-up message to an agent run that is still executing (e.g. one you started with background: true). The message is delivered at the run\'s next step boundary.',
      parameters: z.object({
        run_id: z.string().describe('ULID of the currently-running agent run.'),
        message: z.string().describe('Follow-up instruction for the running agent.'),
      }),
      execute: async ({ run_id, message }) => {
        if (enqueueMessageForRun(run_id, message)) {
          return `Message queued for run ${run_id} — it will be delivered at the next step boundary.`;
        }
        return `Error: run ${run_id} is not active. To continue a finished run, call delegate_to_agent with run_id=${run_id}.`;
      },
    });
  }

  // ── state_get ─────────────────────────────────────────────────────────────
  tools['state_get'] = tool({
    description: 'Read a value from the shared delegation state. Useful for reading results written by another agent.',
    parameters: z.object({
      key: z.string().describe('State key to read.'),
    }),
    execute: async ({ key }) => {
      emit({
        type: 'state:get',
        invocationId: ctx.self.invocationId,
        rootInvocationId: ctx.rootInvocationId,
        parentInvocationId: ctx.self.parentInvocationId,
        agentName: ctx.self.agent.name,
        depth: ctx.self.depth,
        seq: ctx.nextSeq(),
        ts: Date.now(),
        key,
      });
      return { value: ctx.state[key] ?? null };
    },
  });

  // ── state_set ─────────────────────────────────────────────────────────────
  tools['state_set'] = tool({
    description: 'Write a value to the shared delegation state so other agents can read it.',
    parameters: z.object({
      key: z.string().describe('State key to write.'),
      value: z.unknown().describe('Value to store.'),
    }),
    execute: async ({ key, value }) => {
      ctx.state[key] = value;
      emit({
        type: 'state:set',
        invocationId: ctx.self.invocationId,
        rootInvocationId: ctx.rootInvocationId,
        parentInvocationId: ctx.self.parentInvocationId,
        agentName: ctx.self.agent.name,
        depth: ctx.self.depth,
        seq: ctx.nextSeq(),
        ts: Date.now(),
        key,
        value,
      });
      return { ok: true };
    },
  });

  return tools;
}
