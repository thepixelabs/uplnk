/**
 * uplnk Multi-Agent System — canonical type definitions.
 * ALL other agent modules import from here. Do not duplicate types.
 *
 * See AGENT_SYSTEM.md for the full design spec.
 */

import type { CoreMessage, LanguageModel, Tool } from 'ai';
import type { Db } from '@uplnk/db';

// ─────────────────────────────────────────────────────────────────────────────
// Scalar aliases
// ─────────────────────────────────────────────────────────────────────────────

export type InvocationId = string; // ULID
export type AgentName = string;

export type AgentColor =
  | 'blue'
  | 'cyan'
  | 'green'
  | 'yellow'
  | 'magenta'
  | 'red'
  | 'white'
  | 'gray'
  | `#${string}`;

export type AgentEffort = 'low' | 'medium' | 'high' | 'max';
export type AgentMemoryScope = 'none' | 'project' | 'user' | 'local';
export type AgentModelSpec = 'inherit' | string;

// ─────────────────────────────────────────────────────────────────────────────
// AgentDef — parsed + validated agent definition
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentHandoff {
  label: string;
  agent: string;
  prompt: string;
  send?: 'result' | 'none';
}

export interface AgentAutoInvokeRule {
  on: 'file-change' | 'keyword';
  pattern: string;
}

export interface AgentDef {
  /** Unique kebab-case name. Matches frontmatter `name:`. */
  name: string;
  /** One-liner used by orchestrator selection + UI. Must include trigger examples. */
  description: string;
  /** Markdown body (everything after the frontmatter fence). Used as the system prompt. */
  systemPrompt: string;

  // ── Model ──────────────────────────────────────────────────────────────────
  model: AgentModelSpec;
  provider?: string;
  temperature?: number;
  effort?: AgentEffort;

  // ── Tool access ────────────────────────────────────────────────────────────
  /** Allow-list of tool names. `undefined` = inherit all parent tools. `[]` = no tools. */
  tools?: string[];
  /** Deny-list applied after inheritance. */
  toolsDeny?: string[];

  // ── Skills ─────────────────────────────────────────────────────────────────
  skills?: string[];

  // ── Delegation ─────────────────────────────────────────────────────────────
  /** `undefined` or `[]` = cannot delegate. `['*']` = any agent. Otherwise explicit list. */
  agents?: string[];
  /** Max nesting depth this agent may SPAWN beneath itself. Default 1. */
  maxDepth: number;
  handoffs?: AgentHandoff[];

  // ── Memory ─────────────────────────────────────────────────────────────────
  memory: AgentMemoryScope;

  // ── UI ─────────────────────────────────────────────────────────────────────
  color: AgentColor;
  icon: string;

  // ── Invocation ─────────────────────────────────────────────────────────────
  userInvocable: boolean;
  maxTurns: number;
  timeoutMs: number;

  // ── Auto-invoke (not MVP) ──────────────────────────────────────────────────
  autoInvoke?: AgentAutoInvokeRule[];

  // ── Source metadata ────────────────────────────────────────────────────────
  source: 'builtin' | 'user' | 'project';
  sourcePath: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentEvent — unified event bus discriminated union
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentEventBase {
  /** ULID of the specific agent run this event belongs to. */
  invocationId: InvocationId;
  /** All events in a delegation tree share this root id. UI groups by it. */
  rootInvocationId: InvocationId;
  /** Parent invocation id, or null for the root. */
  parentInvocationId: InvocationId | null;
  /** Agent that emitted this event. */
  agentName: AgentName;
  /** Delegation depth: 1 for the first @mention, 2 for its children, … */
  depth: number;
  /** Monotonic sequence number within this invocation. */
  seq: number;
  /** Wall-clock ms since epoch. */
  ts: number;
}

export type AgentEvent =
  // Lifecycle
  | (AgentEventBase & {
      type: 'agent:start';
      userPrompt: string;
      model: string;
      /** Set when this run resumed a prior finished run's transcript (continuation). */
      resumedFromRunId?: InvocationId;
    })
  | (AgentEventBase & {
      type: 'agent:end';
      finalText: string;
      usage: { inputTokens: number; outputTokens: number };
      durationMs: number;
    })
  | (AgentEventBase & { type: 'agent:error'; error: { code: string; message: string } })
  | (AgentEventBase & { type: 'agent:aborted'; reason: string })
  // Streaming text
  | (AgentEventBase & { type: 'text:delta'; delta: string })
  // Tool calls made BY this agent (not delegations)
  | (AgentEventBase & { type: 'tool:call'; toolCallId: string; toolName: string; args: unknown })
  | (AgentEventBase & {
      type: 'tool:result';
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    })
  // Delegation edges (emitted on the PARENT invocation)
  | (AgentEventBase & {
      type: 'delegate:spawn';
      childInvocationId: InvocationId;
      childAgent: AgentName;
      mode: 'delegate' | 'ask';
      prompt: string;
    })
  | (AgentEventBase & {
      type: 'delegate:return';
      childInvocationId: InvocationId;
      childAgent: AgentName;
      mode: 'delegate' | 'ask';
      summary: string;
    })
  /**
   * A background delegation (`delegate_to_agent` with `background: true`)
   * finished or errored. Emitted on the PARENT invocation, possibly long
   * after the parent's own turn ended — subscribers that outlive the turn
   * (e.g. the chat screen) use it to surface the persisted notification.
   */
  | (AgentEventBase & {
      type: 'delegate:background-complete';
      childInvocationId: InvocationId;
      childAgent: AgentName;
      status: 'completed' | 'errored';
      /** Child's final text on success, error message on failure. */
      summary: string;
      /** Exact text persisted as the notification message (label + summary). */
      notification: string;
      /** Conversation the notification was persisted into, or null when unavailable. */
      conversationId: string | null;
      /** Persisted notification message id, or null when persistence was unavailable. */
      messageId: string | null;
    })
  // Shared state (for UI inspector)
  | (AgentEventBase & { type: 'state:set'; key: string; value: unknown })
  | (AgentEventBase & { type: 'state:get'; key: string })
  // Room (multi-agent visible transcript) events — emitted by RoomConductor
  | (AgentEventBase & {
      type: 'room:turn-start';
      turnId: string;
      addressees: AgentName[];
      cc: AgentName[];
    })
  | (AgentEventBase & {
      type: 'room:handoff';
      turnId: string;
      from: AgentName;
      to: AgentName;
      message: string;
    })
  | (AgentEventBase & {
      type: 'room:spawn';
      turnId: string;
      spawnedName: AgentName;
      spawnedBy: AgentName;
    })
  | (AgentEventBase & {
      type: 'room:budget-warn';
      turnId: string;
      reason: string;
      usage: { handoffs: number; tokens: number; wallMs: number };
    })
  | (AgentEventBase & {
      type: 'room:ping-pong';
      turnId: string;
      between: [AgentName, AgentName];
    })
  | (AgentEventBase & {
      type: 'room:turn-end';
      turnId: string;
      reason: 'done' | 'budget' | 'ping-pong' | 'error' | 'aborted';
      handoffs: number;
    })
  // ── Wave 2 wire-up events (B.1.4 contextBudget + B.1.5 loopBreaker) ────────
  /**
   * Emitted when trimMessagesForContext dropped or truncated messages to fit
   * the model's input budget. UI surfaces this as a "trimmed N messages"
   * notice — the trim is non-fatal.
   */
  | (AgentEventBase & {
      type: 'context:trimmed';
      droppedCount: number;
      truncations: Record<number, string>;
      estimatedInputTokens: number;
      inputBudget: number;
    })
  /**
   * Emitted when the LoopBreaker decides the model is wedged on the same
   * tool call and force-answer should fire. Wave 2 emits + logs only — the
   * actual abort+retry mechanism is deferred to a follow-up wave.
   */
  | (AgentEventBase & {
      type: 'loop-breaker:fire';
      action: 'force-answer' | 'force-error';
      reason: string;
      snapshot: {
        recentSignatures: ReadonlyArray<{ toolName: string; argsHash: string }>;
        perToolCallCounts: Readonly<Record<string, number>>;
        stuckCount: number;
      };
    });

// ─────────────────────────────────────────────────────────────────────────────
// EphemeralAgentSpec — input to the `spawn_agent` tool
// ─────────────────────────────────────────────────────────────────────────────

export interface EphemeralAgentSpec {
  name: string;
  systemPrompt: string;
  /** Must be ⊆ caller's effective tools. */
  tools?: string[];
  model?: AgentModelSpec;
  maxTurns?: number;
  maxDepth?: number;
  /** First user-visible message the spawned agent receives. */
  firstMessage: string;
  color?: AgentColor;
  icon?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// MentionCandidate — unified @ popover type
// ─────────────────────────────────────────────────────────────────────────────

export type MentionCandidate =
  | {
      kind: 'agent';
      insertText: string;
      name: string;
      description: string;
      icon: string;
      color: AgentColor;
      source: 'builtin' | 'user' | 'project';
    }
  | {
      kind: 'file';
      insertText: string;
      path: string;
    }
  | {
      kind: 'folder';
      insertText: string;
      path: string;
    };

// ─────────────────────────────────────────────────────────────────────────────
// DelegationContext — passed through tool.execute() closures
// ─────────────────────────────────────────────────────────────────────────────

export interface DelegationContext {
  self: {
    invocationId: InvocationId;
    parentInvocationId: InvocationId | null;
    agent: AgentDef;
    depth: number;
  };
  rootInvocationId: InvocationId;
  /** Linear path from root to self, inclusive — used for cycle detection. */
  ancestry: AgentName[];
  /** Shared mutable state bag keyed by root invocation. */
  state: Record<string, unknown>;
  /** Monotonic sequence counter for this root tree. */
  nextSeq: () => number;
  signal: AbortSignal;
  orchestrator: IAgentOrchestrator;
  registry: IAgentRegistry;
  /** Parent's model so children with `model: inherit` reuse it. */
  inheritedModel: LanguageModel;
  /** Parent's tools so children with `tools: undefined` inherit them. */
  inheritedTools: Record<string, Tool>;
  /**
   * Resolves a model spec through the SAME path the orchestrator uses
   * (its modelFactory). Delegation tools call it to validate per-call
   * model/provider overrides before spawning — a throw means "unknown".
   */
  resolveModel?: (spec: { model: AgentModelSpec; provider?: string }) => LanguageModel;
  /**
   * DB handle + owning conversation — both optional. When present they enable
   * continuation (`run_id`) and background-delegation persistence in the
   * delegation tools; when absent those paths return clear error strings.
   */
  db?: Db;
  conversationId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry + Orchestrator interfaces
// ─────────────────────────────────────────────────────────────────────────────

export interface IAgentRegistry {
  list(): AgentDef[];
  get(name: string): AgentDef | undefined;
  reload(projectDir?: string): Promise<void>;
}

/**
 * Per-call overrides supplied by delegation tools. Take precedence over the
 * AgentDef's model/provider/temperature but NEVER over hard limits — maxTurns,
 * timeoutMs and depth always come from the definition.
 */
export interface AgentRunOverrides {
  model?: string;
  provider?: string;
  temperature?: number;
}

export interface RunAgentOptions {
  agent: AgentDef;
  userPrompt: string;
  history?: CoreMessage[];
  /** Override the rootInvocationId (used by useAgentRun to align with its subscription key). */
  rootInvocationIdOverride?: InvocationId;
  /**
   * Pre-mint the run's own invocationId. Background delegation uses this so
   * the tool can return the run id to the caller BEFORE run() resolves.
   */
  invocationIdOverride?: InvocationId;
  /** Per-call model/provider/temperature overrides (see AgentRunOverrides). */
  overrides?: AgentRunOverrides;
  /** Lineage marker for continuation runs — threaded into `agent:start`. */
  resumedFromRunId?: InvocationId;
  /**
   * Conversation this run belongs to. Threaded into the DelegationContext so
   * delegation tools can persist / look up runs for continuation + background.
   */
  conversationId?: string;
  parent?: {
    invocationId: InvocationId;
    depth: number;
    ancestry: AgentName[];
    rootInvocationId: InvocationId;
    state: Record<string, unknown>;
    nextSeq: () => number;
    inheritedModel: LanguageModel;
    inheritedTools: Record<string, Tool>;
  };
  signal: AbortSignal;
  /**
   * Extra tools merged into effective tools AFTER the agent's allow/deny lists
   * are applied. Used by RoomConductor to inject visible-handoff tools for a
   * single in-room invocation without polluting the agent's .md definition.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraTools?: Record<string, Tool<any, any>>;
  /**
   * Live context window in tokens for the chosen model. Drives the input
   * budget passed to trimMessagesForContext. Undefined falls back to a
   * conservative default inside the orchestrator.
   */
  contextWindow?: number;
}

export interface RunAgentResult {
  invocationId: InvocationId;
  finalText: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface IAgentOrchestrator {
  run(opts: RunAgentOptions): Promise<RunAgentResult>;
}
