/**
 * uplnk Multi-Agent System — canonical type definitions.
 * ALL other agent modules import from here. Do not duplicate types.
 *
 * See AGENT_SYSTEM.md for the full design spec.
 */

import type { CoreMessage, LanguageModel, Tool } from 'ai';

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
  | (AgentEventBase & { type: 'agent:start'; userPrompt: string; model: string })
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
  // Shared state (for UI inspector)
  | (AgentEventBase & { type: 'state:set'; key: string; value: unknown })
  | (AgentEventBase & { type: 'state:get'; key: string });

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
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry + Orchestrator interfaces
// ─────────────────────────────────────────────────────────────────────────────

export interface IAgentRegistry {
  list(): AgentDef[];
  get(name: string): AgentDef | undefined;
  reload(projectDir?: string): Promise<void>;
}

export interface RunAgentOptions {
  agent: AgentDef;
  userPrompt: string;
  history?: CoreMessage[];
  /** Override the rootInvocationId (used by useAgentRun to align with its subscription key). */
  rootInvocationIdOverride?: InvocationId;
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
}

export interface RunAgentResult {
  invocationId: InvocationId;
  finalText: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface IAgentOrchestrator {
  run(opts: RunAgentOptions): Promise<RunAgentResult>;
}
