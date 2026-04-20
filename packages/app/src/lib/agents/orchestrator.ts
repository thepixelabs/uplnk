/**
 * AgentOrchestrator — spawns agent invocations using the Vercel AI SDK.
 *
 * Each invocation gets a fresh, isolated context window. The parent LLM only
 * ever sees the final summary string returned via the delegation tool result —
 * never the child's full transcript.
 *
 * Event bus is the ONLY path for event emission. There is no secondary emit
 * callback — all subscribers go through the bus. This prevents double-emission.
 *
 * See AGENT_SYSTEM.md §3.3 for the full run() contract.
 */

import { streamText } from 'ai';
import type { LanguageModel, Tool, CoreMessage } from 'ai';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any>;

import { ulid } from 'ulid';
import { buildDelegationTools } from './delegationTools.js';
import type {
  AgentEvent,
  AgentModelSpec,
  DelegationContext,
  IAgentOrchestrator,
  IAgentRegistry,
  RunAgentOptions,
  RunAgentResult,
} from './types.js';
import type { AgentEventBus } from './eventBus.js';

const GLOBAL_MAX_DEPTH = 5;

export interface AgentOrchestratorDeps {
  registry: IAgentRegistry;
  /** Resolves a model spec to a LanguageModel instance. */
  modelFactory: (spec: { model: AgentModelSpec; provider?: string }) => LanguageModel;
  /** Root tool set — children inherit + filter from this. */
  rootTools: Record<string, AnyTool>;
  eventBus: AgentEventBus;
}

export class AgentOrchestrator implements IAgentOrchestrator {
  private readonly deps: AgentOrchestratorDeps;

  constructor(deps: AgentOrchestratorDeps) {
    this.deps = deps;
  }

  async run(opts: RunAgentOptions): Promise<RunAgentResult> {
    const { agent, userPrompt, history = [], parent, signal, extraTools } = opts;
    const { registry, modelFactory, rootTools, eventBus } = this.deps;

    // ── Step 1: Mint invocation id ───────────────────────────────────────────
    const invocationId = ulid();

    // ── Step 2-4: Depth, ancestry, root id ──────────────────────────────────
    const depth = parent ? parent.depth + 1 : 1;

    // Global depth cap enforced here, not just in delegation tools
    if (depth > GLOBAL_MAX_DEPTH) {
      throw new Error(
        `Global delegation depth cap (${GLOBAL_MAX_DEPTH}) exceeded. Cannot start agent @${agent.name} at depth ${depth}.`,
      );
    }

    const ancestry = [...(parent?.ancestry ?? []), agent.name];
    // rootInvocationId: prefer parent's, then override (for useAgentRun alignment), then self
    const rootInvocationId =
      parent?.rootInvocationId ?? opts.rootInvocationIdOverride ?? invocationId;

    // Monotonic seq counter — shared across the whole tree via parent, fresh for root
    const nextSeq: () => number =
      parent?.nextSeq ?? (() => { let n = 0; return () => n++; })();

    const parentInvocationId = parent?.invocationId ?? null;

    // ── Step 5: Resolve model ────────────────────────────────────────────────
    const effectiveModel: LanguageModel =
      agent.model === 'inherit' && parent
        ? parent.inheritedModel
        : modelFactory({
            model: agent.model,
            ...(agent.provider !== undefined ? { provider: agent.provider } : {}),
          });

    // ── Step 6: Compute effective tools ─────────────────────────────────────
    const baseTools: Record<string, AnyTool> = parent?.inheritedTools ?? rootTools;

    let effectiveTools: Record<string, AnyTool>;
    if (agent.tools === undefined) {
      effectiveTools = { ...baseTools };
    } else if (agent.tools.length === 0) {
      effectiveTools = {};
    } else {
      effectiveTools = {};
      for (const name of agent.tools) {
        if (baseTools[name] !== undefined) {
          effectiveTools[name] = baseTools[name]!;
        }
      }
    }

    // Apply deny list
    if (agent.toolsDeny) {
      for (const name of agent.toolsDeny) {
        delete effectiveTools[name];
      }
    }

    // Helper — emit to bus only (single path, no double-emission)
    const emit = (event: AgentEvent): void => {
      eventBus.emitEvent(event);
    };

    // Build DelegationContext — passed to delegation tools via closure
    const state: Record<string, unknown> = parent?.state ?? {};

    const ctx: DelegationContext = {
      self: { invocationId, parentInvocationId, agent, depth },
      rootInvocationId,
      ancestry,
      state,
      nextSeq,
      signal,
      orchestrator: this,
      registry,
      inheritedModel: effectiveModel,
      inheritedTools: effectiveTools,
    };

    // Add delegation + state tools unconditionally (buildDelegationTools handles empty allowlist)
    const delegationTools = buildDelegationTools(ctx, emit);
    Object.assign(effectiveTools, delegationTools);

    // Merge any caller-injected room / tooling additions on top. These bypass
    // the agent.tools allow-list deliberately — the conductor is trusted to
    // decide what's in scope for each invocation of the turn.
    if (extraTools) Object.assign(effectiveTools, extraTools);

    // ── Step 7: Emit start event ─────────────────────────────────────────────
    emit({
      type: 'agent:start',
      invocationId,
      rootInvocationId,
      parentInvocationId,
      agentName: agent.name,
      depth,
      seq: nextSeq(),
      ts: Date.now(),
      userPrompt,
      model: agent.model,
    });

    const startMs = Date.now();

    // ── Steps 8–12: streamText + event pumping ────────────────────────────────
    // Enforce timeoutMs with AbortSignal.any (Node 20+)
    const timeoutSignal = AbortSignal.timeout(agent.timeoutMs);
    const combinedSignal = AbortSignal.any([signal, timeoutSignal]);

    try {
      const messages: CoreMessage[] = [
        ...history,
        { role: 'user', content: userPrompt },
      ];

      const hasTools = Object.keys(effectiveTools).length > 0;

      const stream = streamText({
        model: effectiveModel,
        messages,
        maxSteps: agent.maxTurns,
        abortSignal: combinedSignal,
        ...(agent.systemPrompt ? { system: agent.systemPrompt } : {}),
        ...(hasTools ? { tools: effectiveTools } : {}),
        ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
      });

      let finalText = '';
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const part of stream.fullStream) {
        if (combinedSignal.aborted) break;

        if (part.type === 'text-delta') {
          finalText += part.textDelta;
          emit({
            type: 'text:delta',
            invocationId,
            rootInvocationId,
            parentInvocationId,
            agentName: agent.name,
            depth,
            seq: nextSeq(),
            ts: Date.now(),
            delta: part.textDelta,
          });
        } else if (part.type === 'tool-call') {
          emit({
            type: 'tool:call',
            invocationId,
            rootInvocationId,
            parentInvocationId,
            agentName: agent.name,
            depth,
            seq: nextSeq(),
            ts: Date.now(),
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: part.args,
          });
        } else if (part.type === 'finish') {
          inputTokens = part.usage?.promptTokens ?? 0;
          outputTokens = part.usage?.completionTokens ?? 0;
        }
      }

      // Fallback: grab text from promise if streaming didn't capture it
      if (finalText === '') {
        finalText = await stream.text.catch(() => '');
      }

      const durationMs = Date.now() - startMs;

      emit({
        type: 'agent:end',
        invocationId,
        rootInvocationId,
        parentInvocationId,
        agentName: agent.name,
        depth,
        seq: nextSeq(),
        ts: Date.now(),
        finalText,
        usage: { inputTokens, outputTokens },
        durationMs,
      });

      return { invocationId, finalText, usage: { inputTokens, outputTokens } };
    } catch (err) {
      const isAbort =
        combinedSignal.aborted ||
        (err instanceof Error && err.name === 'AbortError');
      const isTimeout = timeoutSignal.aborted && !signal.aborted;

      if (isAbort) {
        emit({
          type: 'agent:aborted',
          invocationId,
          rootInvocationId,
          parentInvocationId,
          agentName: agent.name,
          depth,
          seq: nextSeq(),
          ts: Date.now(),
          reason: isTimeout ? `Timed out after ${agent.timeoutMs}ms` : 'User aborted',
        });
        throw err;
      }

      const errorMsg = err instanceof Error ? err.message : String(err);
      emit({
        type: 'agent:error',
        invocationId,
        rootInvocationId,
        parentInvocationId,
        agentName: agent.name,
        depth,
        seq: nextSeq(),
        ts: Date.now(),
        error: { code: 'AGENT_ERROR', message: errorMsg },
      });
      throw err;
    }
  }
}
