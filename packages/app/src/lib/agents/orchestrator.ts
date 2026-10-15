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
  AgentName,
  DelegationContext,
  IAgentOrchestrator,
  IAgentRegistry,
  InvocationId,
  RunAgentOptions,
  RunAgentResult,
} from './types.js';
import type { Db } from '@uplnk/db';
import type { AgentEventBus } from './eventBus.js';
import type { ISkillRegistry } from '../skills/types.js';
import type { IMemoryRegistry } from '../memory/types.js';
import type { MemoryStore } from '../memory/store.js';
import { retrieve as retrieveMemories } from '../memory/retrieve.js';
import {
  wrapUntrustedBatch,
  UNTRUSTED_CONTEXT_POLICY,
  type UntrustedSource,
} from '../promptSecurity.js';
import { sanitizeMessages } from '../sanitizeMessages.js';
import { stripReasoningContent } from '../stripReasoningContent.js';
import {
  trimMessagesForContext,
  type TrimResult,
} from '../contextBudget.js';
import { selectTools } from '../toolSelection.js';
import {
  LoopBreaker,
  makeSignature,
  wrapToolsWithLoopBreaker,
} from '../loopBreaker.js';

const GLOBAL_MAX_DEPTH = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Tool-allowlist resolution — real MCP names + Claude-Code-style aliases
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compatibility alias map: Claude-Code-style tool names → uplnk's real root
 * tool names (see lib/mcp/servers/*). Applied when resolving USER- or
 * PROJECT-authored agent definitions so a def copied from a Claude Code
 * setup still yields a usable toolset. Builtins ship with real names.
 */
export const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  Read: 'mcp_file_read',
  List: 'mcp_file_list',
  LS: 'mcp_file_list',
  Glob: 'mcp_file_list',
  Grep: 'mcp_rag_search',
  Write: 'mcp_file_write',
  Edit: 'mcp_file_patch',
  Patch: 'mcp_file_patch',
  Bash: 'mcp_command_exec',
};

/** One-time warning keys (per process) so alias/unknown warnings don't spam. */
const warnedToolNameKeys = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedToolNameKeys.has(key)) return;
  warnedToolNameKeys.add(key);
  console.warn(message);
}

/**
 * Resolve an agent's `tools:` allowlist against the base toolset.
 *
 * Precedence per entry:
 *   1. Exact name match in `baseTools` — always wins.
 *   2. Compatibility alias (user/project-authored defs only) — included under
 *      the REAL name, with a one-time warning naming the alias used.
 *   3. Unknown — not granted (existing behaviour), with a one-time warning so
 *      a silently-empty toolset is no longer silent.
 *
 * Exported for tests; the orchestrator's Step 6 is the only runtime caller.
 */
export function resolveToolAllowlist(
  allowlist: readonly string[],
  baseTools: Record<string, AnyTool>,
  opts: { agentName: string; source: 'builtin' | 'user' | 'project' },
): Record<string, AnyTool> {
  const resolved: Record<string, AnyTool> = {};
  for (const name of allowlist) {
    if (baseTools[name] !== undefined) {
      resolved[name] = baseTools[name]!;
      continue;
    }
    const alias = opts.source !== 'builtin' ? TOOL_NAME_ALIASES[name] : undefined;
    if (alias !== undefined && baseTools[alias] !== undefined) {
      resolved[alias] = baseTools[alias]!;
      warnOnce(
        `alias:${opts.agentName}:${name}`,
        `[AgentOrchestrator] @${opts.agentName}: tool '${name}' resolved via compatibility alias → '${alias}'. Update the agent definition to use the real tool name.`,
      );
      continue;
    }
    warnOnce(
      `unknown:${opts.agentName}:${name}`,
      `[AgentOrchestrator] @${opts.agentName}: tool '${name}' not found in the available toolset — not granted.`,
    );
  }
  return resolved;
}

/**
 * Below this size, sending all tool schemas is cheaper than running BM25
 * over them; cf. Tier 1 row 1.3. Above the threshold, selectTools picks
 * topK=8 + alwaysAvailable (rag/delegation tools).
 */
const TOOL_SELECTION_THRESHOLD = 8;
const TOOL_SELECTION_TOP_K = 8;

/** Conservative fallback for models that did not report a contextWindow. */
const DEFAULT_CONTEXT_WINDOW = 8192;

/**
 * Always-available tool name prefixes. RAG search is broadly useful so we
 * never let it be filtered out; same for the delegation entrypoints which
 * the agent needs in order to route to sub-agents.
 */
const ALWAYS_AVAILABLE_PREFIXES: readonly string[] = ['mcp_rag_'];
const ALWAYS_AVAILABLE_EXACT: ReadonlySet<string> = new Set([
  'delegate_to',
  'ask',
  'spawn_agent',
]);

function isAlwaysAvailable(name: string): boolean {
  if (ALWAYS_AVAILABLE_EXACT.has(name)) return true;
  for (const prefix of ALWAYS_AVAILABLE_PREFIXES) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Live-run registry — in-process map of currently-executing invocations.
//
// send_to_agent enqueues follow-up messages here; run() drains the queue at
// each step boundary (i.e. when the current streamText call finishes its
// steps — the AI SDK cannot accept mid-call message additions, so a non-empty
// queue triggers another streamText continuation while turn budget remains).
//
// In-process only, per the locked "Daemon mode: NO" decision (plan §7.1):
// entries — like the runs they track — die with the process.
// ─────────────────────────────────────────────────────────────────────────────

interface LiveRunEntry {
  agentName: AgentName;
  queue: string[];
}

const liveRuns = new Map<InvocationId, LiveRunEntry>();

/** True when the given run id is currently executing in this process. */
export function isRunActive(runId: InvocationId): boolean {
  return liveRuns.has(runId);
}

/**
 * Enqueue a follow-up message for a live run. Returns false when the run is
 * not active — callers surface that as "use continuation instead".
 */
export function enqueueMessageForRun(runId: InvocationId, message: string): boolean {
  const entry = liveRuns.get(runId);
  if (entry === undefined) return false;
  entry.queue.push(message);
  return true;
}

/** Drain (and clear) the pending queue for a run. Internal to run()'s loop. */
function drainRunQueue(runId: InvocationId): string[] {
  const entry = liveRuns.get(runId);
  if (entry === undefined || entry.queue.length === 0) return [];
  return entry.queue.splice(0);
}

/**
 * Extract the SDK's response messages from a finished streamText result so a
 * continuation round keeps tool calls/results intact. Returns undefined when
 * the result does not expose them (e.g. test stubs) — callers fall back to a
 * plain assistant text message.
 */
async function readResponseMessages(stream: unknown): Promise<CoreMessage[] | undefined> {
  const response = (stream as { response?: Promise<{ messages?: unknown }> }).response;
  if (response === undefined) return undefined;
  try {
    const { messages } = await response;
    return Array.isArray(messages) && messages.length > 0
      ? (messages as CoreMessage[])
      : undefined;
  } catch {
    return undefined;
  }
}

export interface AgentOrchestratorDeps {
  registry: IAgentRegistry;
  /** Resolves a model spec to a LanguageModel instance. */
  modelFactory: (spec: { model: AgentModelSpec; provider?: string }) => LanguageModel;
  /** Root tool set — children inherit + filter from this. */
  rootTools: Record<string, AnyTool>;
  eventBus: AgentEventBus;
  /**
   * Optional — when present, agents that declare `skills: [name, ...]` in
   * frontmatter get those skill bodies loaded and injected as untrusted-context
   * user messages before the first user turn. Omitted in tests that don't care.
   */
  skillRegistry?: ISkillRegistry;
  /**
   * Optional — when present, pinned + retrieved memories are batched alongside
   * skill sources into a single untrusted-context message. Retrieved against
   * the LAST USER MESSAGE TEXT only (Wave 1 C-agent recommendation).
   */
  memoryRegistry?: IMemoryRegistry;
  /**
   * Optional — when present, `lastUsed` is bumped on every memory the
   * orchestrator actually injects. Skipped on empty-query paths so the
   * bump tracks real retrieval, not session start.
   */
  memoryStore?: MemoryStore;
  /**
   * Optional — DB handle threaded into the DelegationContext. Enables the
   * continuation (`run_id`) and background-delegation persistence paths in
   * the delegation tools. Omitted in tests that don't exercise them.
   */
  db?: Db;
  /**
   * Loop-breaker policy for the agent path. When `intervene` is true
   * (the DEFAULT — omitted deps behave as `{ intervene: true }`), the 3rd
   * consecutive identical tool call (same name + normalized-args-hash) is
   * blocked: a synthetic "stop repeating" tool result is returned instead of
   * executing, and the existing `loop-breaker:fire` event is emitted so the
   * TUI surfaces it. `intervene: false` restores the emit/log-only behaviour.
   * Wired from `config.loopBreaker` (lib/config.ts).
   */
  loopBreaker?: { intervene?: boolean };
}

export class AgentOrchestrator implements IAgentOrchestrator {
  private readonly deps: AgentOrchestratorDeps;

  constructor(deps: AgentOrchestratorDeps) {
    this.deps = deps;
  }

  async run(opts: RunAgentOptions): Promise<RunAgentResult> {
    const { agent, userPrompt, history = [], parent, signal, extraTools, overrides } = opts;
    const {
      registry,
      modelFactory,
      rootTools,
      eventBus,
      skillRegistry,
      memoryRegistry,
      memoryStore,
      db,
    } = this.deps;

    // ── Step 1: Mint invocation id ───────────────────────────────────────────
    // Background delegation pre-mints the id so the tool can return it to the
    // caller before this promise resolves.
    const invocationId = opts.invocationIdOverride ?? ulid();

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
    // Per-call overrides win over the AgentDef, but hard limits (maxTurns,
    // timeoutMs, depth) always stay with the definition — overrides carry
    // model/provider/temperature only, by construction of AgentRunOverrides.
    const modelSpec: AgentModelSpec = overrides?.model ?? agent.model;
    const providerSpec = overrides?.provider ?? agent.provider;
    const effectiveModel: LanguageModel =
      modelSpec === 'inherit' && parent
        ? parent.inheritedModel
        : modelFactory({
            model: modelSpec,
            ...(providerSpec !== undefined ? { provider: providerSpec } : {}),
          });
    const effectiveTemperature = overrides?.temperature ?? agent.temperature;

    // ── Step 6: Compute effective tools ─────────────────────────────────────
    const baseTools: Record<string, AnyTool> = parent?.inheritedTools ?? rootTools;

    let effectiveTools: Record<string, AnyTool>;
    if (agent.tools === undefined) {
      effectiveTools = { ...baseTools };
    } else if (agent.tools.length === 0) {
      effectiveTools = {};
    } else {
      effectiveTools = resolveToolAllowlist(agent.tools, baseTools, {
        agentName: agent.name,
        source: agent.source,
      });
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
      // Same resolution path as Step 5 — delegation tools use it to validate
      // per-call model/provider overrides before spawning.
      resolveModel: (spec) => modelFactory(spec),
      ...(db !== undefined ? { db } : {}),
      ...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}),
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
      model: modelSpec,
      ...(opts.resumedFromRunId !== undefined
        ? { resumedFromRunId: opts.resumedFromRunId }
        : {}),
    });

    const startMs = Date.now();

    // ── Steps 8–12: streamText + event pumping ────────────────────────────────
    // Enforce timeoutMs with AbortSignal.any (Node 20+)
    const timeoutSignal = AbortSignal.timeout(agent.timeoutMs);
    const combinedSignal = AbortSignal.any([signal, timeoutSignal]);

    // Register in the live-run map so send_to_agent can reach this run.
    // Registration is synchronous before the first await, so a background
    // delegation's returned run id is immediately addressable.
    liveRuns.set(invocationId, { agentName: agent.name, queue: [] });

    try {
      // ── Resolve memories (pinned + retrieved) → UntrustedSource[] ──────────
      // Retrieve against the LAST USER MESSAGE TEXT only — the prompt the user
      // just typed is by far the strongest topical signal. Using the whole
      // history bleeds older turns into the score and surfaces stale memories.
      // (Locked decision: see plan §4c "Open questions" → "Retrieve at
      // orchestrator on last-user-message".)
      const memorySources: UntrustedSource[] = [];
      const injectedMemoryNames: string[] = [];
      if (memoryRegistry !== undefined) {
        const retrieved = retrieveMemories(memoryRegistry, userPrompt, { topK: 3 });
        // Order: pinned first (in retrieve()'s natural order), then non-pinned
        // matched, then skills below. Inject DESCRIPTION only — body is used
        // for BM25 ranking but spending tokens on it would defeat the budget.
        for (const m of retrieved) {
          memorySources.push({ label: `memory:${m.name}`, content: m.description });
          injectedMemoryNames.push(m.name);
        }
        // Bump lastUsed only when the query produced non-pinned injections,
        // i.e. a real retrieval happened. Session-start "pinned only" paths
        // (empty query) skip the bump per spec.
        if (memoryStore !== undefined && userPrompt.trim().length > 0) {
          for (const name of injectedMemoryNames) {
            try { memoryStore.updateLastUsed(name); } catch { /* non-fatal */ }
          }
        }
      }

      // ── Resolve agent.skills → UntrustedSource[] ───────────────────────────
      const skillSources: UntrustedSource[] =
        agent.skills && agent.skills.length > 0 && skillRegistry !== undefined
          ? skillRegistry
              .resolve(agent.skills)
              .map((s) => ({ label: `skill:${s.name}`, content: s.body }))
          : [];

      // Combine into ONE wrapped batch: memories first (pinned then non-pinned
      // already ordered by retrieve()), then skills. A single batch saves a
      // tokenizer separator between sources and matches the pattern Phase A
      // established for skills alone.
      const combinedSources = [...memorySources, ...skillSources];
      const untrustedMessage = wrapUntrustedBatch(combinedSources);

      const rawMessages: CoreMessage[] = [
        ...history,
        ...(untrustedMessage ? [untrustedMessage] : []),
        { role: 'user', content: userPrompt },
      ];
      // Defensive pre-send pass: drop orphan tool messages, unanswered tool-calls,
      // merge consecutive user turns. Prevents 400s from providers that strictly
      // validate message shape (e.g. OpenAI). See lib/sanitizeMessages.ts.
      // Then strip reasoning content from all but the most recent assistant
      // turn — keeps reasoning models from accumulating stale CoT each round.
      const sanitized = stripReasoningContent(sanitizeMessages(rawMessages));

      // Trim history to fit the model's input budget. System prompt is passed
      // separately to streamText (see `system:` below), so we have no protected
      // index inside `sanitized` itself — the trimmer's own "protect last user"
      // and "protect recent" invariants cover the must-keep set.
      const contextWindow = opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      const trimResult: TrimResult = trimMessagesForContext(sanitized, {
        contextWindow,
        inputBudgetRatio: 0.85,
        protectedIndices: [],
      });
      const messages = trimResult.messages;
      if (
        trimResult.trimmed ||
        trimResult.droppedCount > 0 ||
        Object.keys(trimResult.truncations).length > 0
      ) {
        emit({
          type: 'context:trimmed',
          invocationId,
          rootInvocationId,
          parentInvocationId,
          agentName: agent.name,
          depth,
          seq: nextSeq(),
          ts: Date.now(),
          droppedCount: trimResult.droppedCount,
          truncations: trimResult.truncations,
          estimatedInputTokens: trimResult.estimatedInputTokens,
          inputBudget: trimResult.inputBudget,
        });
      }

      // ── Tool selection — apply BM25 filter only when above threshold ───────
      // Below TOOL_SELECTION_THRESHOLD, every tool already fits inside a 4k
      // local model's budget and ranking is overhead. Above it, we keep the
      // alwaysAvailable set (delegation, RAG search) plus the top-K best
      // matches against the user prompt.
      let toolsForStream: Record<string, AnyTool> = effectiveTools;
      const toolNames = Object.keys(effectiveTools);
      if (toolNames.length > TOOL_SELECTION_THRESHOLD) {
        // Snake_case fix (per B.1.3 finding): BM25 tokenizes "web_search" as
        // a single term, so a query asking for "web search" never scores.
        // Option (b) — EXPAND the description with the space-split name so
        // the scorer sees both forms; the canonical name (the registry key)
        // stays untouched, which keeps wire-up downstream simple.
        const expandedTools: Record<string, { description: string }> = {};
        for (const name of toolNames) {
          const t = effectiveTools[name]!;
          const desc = typeof t.description === 'string' ? t.description : '';
          const expanded = `${desc} ${name.replace(/_/g, ' ')}`.trim();
          expandedTools[name] = { description: expanded };
        }
        const alwaysAvailable = toolNames.filter(isAlwaysAvailable);
        const sel = selectTools({
          userMessage: userPrompt,
          tools: expandedTools,
          alwaysAvailable,
          topK: TOOL_SELECTION_TOP_K,
        });
        if (sel.selected.length > 0) {
          const filtered: Record<string, AnyTool> = {};
          for (const name of sel.selected) {
            const tool = effectiveTools[name];
            if (tool !== undefined) filtered[name] = tool;
          }
          toolsForStream = filtered;
        }
      }
      const hasTools = Object.keys(toolsForStream).length > 0;

      // Prepend the untrusted-context policy to the agent's system prompt only
      // when we actually injected wrapped content. Keeps cold runs unchanged.
      const systemPrompt = untrustedMessage && agent.systemPrompt
        ? `${UNTRUSTED_CONTEXT_POLICY}\n\n${agent.systemPrompt}`
        : untrustedMessage
          ? UNTRUSTED_CONTEXT_POLICY
          : agent.systemPrompt;

      // Loop-breaker — one instance per invocation, reset() implicit (fresh).
      // Hooks into AI SDK's onStepFinish: per step, observe every tool call
      // signature, and emit `loop-breaker:fire` when the verdict shifts. We
      // log + emit only — no abort+retry this wave (per locked Wave 1 decision).
      const lb = new LoopBreaker();
      let lbFired = false;

      // Loop-breaker intervention (the previously-deferred wave): wrap every
      // tool's execute so the 3rd consecutive identical call (same name +
      // normalized-args-hash) is blocked with a synthetic tool result instead
      // of executing. Wrapped ONCE, before the round loop, so the consecutive
      // counter survives send_to_agent continuation rounds. Config-gated via
      // deps.loopBreaker.intervene — defaults ON for the agent path.
      const interveneEnabled = this.deps.loopBreaker?.intervene ?? true;
      let interventionEventEmitted = false;
      if (hasTools && interveneEnabled) {
        toolsForStream = wrapToolsWithLoopBreaker(toolsForStream, {
          onIntervene: ({ toolName, occurrence }) => {
            console.warn(
              `[loop-breaker] ${agent.name}: intervened — blocked ${toolName} (identical consecutive call #${occurrence}); synthetic result returned`,
            );
            if (interventionEventEmitted) return; // one event per invocation
            interventionEventEmitted = true;
            const snap = lb.snapshot();
            emit({
              type: 'loop-breaker:fire',
              invocationId,
              rootInvocationId,
              parentInvocationId,
              agentName: agent.name,
              depth,
              seq: nextSeq(),
              ts: Date.now(),
              action: 'force-answer',
              reason: `Tool ${toolName} blocked after ${occurrence} identical consecutive calls — synthetic result injected`,
              snapshot: {
                recentSignatures: snap.recentSignatures.map((s) => ({
                  toolName: s.toolName,
                  argsHash: s.argsHash,
                })),
                perToolCallCounts: snap.perToolCallCounts,
                stuckCount: snap.stuckCount,
              },
            });
          },
        });
      }

      // ── streamText round loop ───────────────────────────────────────────────
      // Almost always a single round. Extra rounds happen only when
      // send_to_agent queued messages for this run while it was mid-flight:
      // a single streamText call cannot accept mid-call message additions, so
      // when the current call completes its steps with a non-empty queue and
      // step budget remaining, we run another streamText continuing the
      // transcript with the queued messages appended as user messages.
      let finalText = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let stepsUsed = 0;
      let transcript: CoreMessage[] = messages;

      for (;;) {
        let stepsThisRound = 0;
        let roundText = '';

        const stream = streamText({
          model: effectiveModel,
          messages: transcript,
          maxSteps: Math.max(1, agent.maxTurns - stepsUsed),
          abortSignal: combinedSignal,
          ...(systemPrompt ? { system: systemPrompt } : {}),
          ...(hasTools ? { tools: toolsForStream } : {}),
          ...(effectiveTemperature !== undefined ? { temperature: effectiveTemperature } : {}),
          onStepFinish: (step) => {
            stepsThisRound++;
            // step.toolCalls is the AI SDK's typed ToolCallArray — each entry
            // carries { toolName, args, toolCallId, type }. Other shapes ignored.
            const calls = (step as { toolCalls?: ReadonlyArray<{ toolName: string; args: unknown }> })
              .toolCalls;
            if (calls === undefined || calls.length === 0) return;
            for (const call of calls) {
              const verdict = lb.observe(makeSignature(call.toolName, call.args));
              if (verdict.action !== 'continue' && !lbFired) {
                lbFired = true; // emit once per invocation; downstream policy is future work
                const snap = lb.snapshot();
                emit({
                  type: 'loop-breaker:fire',
                  invocationId,
                  rootInvocationId,
                  parentInvocationId,
                  agentName: agent.name,
                  depth,
                  seq: nextSeq(),
                  ts: Date.now(),
                  action: verdict.action,
                  reason: verdict.reason,
                  snapshot: {
                    recentSignatures: snap.recentSignatures.map((s) => ({
                      toolName: s.toolName,
                      argsHash: s.argsHash,
                    })),
                    perToolCallCounts: snap.perToolCallCounts,
                    stuckCount: snap.stuckCount,
                  },
                });
                console.warn(
                  `[loop-breaker] ${agent.name}: ${verdict.action} — ${verdict.reason}`,
                );
              }
            }
          },
        });

        for await (const part of stream.fullStream) {
          if (combinedSignal.aborted) break;

          if (part.type === 'text-delta') {
            roundText += part.textDelta;
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
            inputTokens += part.usage?.promptTokens ?? 0;
            outputTokens += part.usage?.completionTokens ?? 0;
          }
        }

        // Fallback: grab text from promise if streaming didn't capture it
        if (roundText === '') {
          roundText = await stream.text.catch(() => '');
        }
        finalText = finalText === '' ? roundText : `${finalText}\n\n${roundText}`;
        // A round consumes at least one step even when the provider (or a
        // test stub) never fires onStepFinish — guarantees loop termination.
        stepsUsed += Math.max(1, stepsThisRound);

        // ── Step boundary: drain the send_to_agent queue ──────────────────────
        const queued = drainRunQueue(invocationId);
        if (queued.length === 0 || stepsUsed >= agent.maxTurns || combinedSignal.aborted) {
          break;
        }

        // Continue the transcript. Prefer the SDK's response messages (keeps
        // tool calls/results intact); fall back to plain assistant text.
        const responseMessages = await readResponseMessages(stream);
        transcript = [
          ...transcript,
          ...(responseMessages ?? [{ role: 'assistant' as const, content: roundText }]),
          ...queued.map((m): CoreMessage => ({ role: 'user', content: m })),
        ];
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
    } finally {
      // Undelivered queued messages are dropped with the entry — the run they
      // were addressed to no longer exists.
      liveRuns.delete(invocationId);
    }
  }
}
