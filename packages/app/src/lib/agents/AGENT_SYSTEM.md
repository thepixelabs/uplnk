# uplnk Multi-Agent `@mention` System — Authoritative Design Spec

**Status:** Canonical. Workers implement this verbatim.
**Audience:** Implementation workers (coder, tester, reviewer) + future maintainers.
**Scope:** Everything required to turn `@planner design the auth module` into a live, streaming, delegating subagent graph inside uplnk's Ink TUI, built on the Vercel AI SDK.

---

## 0. Vocabulary

| Term | Meaning |
|---|---|
| **Agent** | A persona defined by an `.md` file with YAML frontmatter + a Markdown system prompt body. |
| **Invocation** | One live run of one agent. Identified by `invocationId` (ULID). |
| **Delegation** | One agent calling another via a tool. Handoff (`delegate_to_agent`) or call-return (`ask_agent`). |
| **Orchestrator** | The module that spawns top-level agent invocations from user input and routes events to the UI. |
| **Event Bus** | An `EventEmitter`-compatible channel streaming `AgentEvent`s keyed by `invocationId`. |
| **Depth** | Delegation nesting level. User → agent A (depth 1) → agent B (depth 2). Root conversation is depth 0. |
| **Shared state** | A per-root-invocation `Record<string, unknown>` written and read by agents via the `state_get` / `state_set` tools. |

---

## 1. TypeScript Interfaces (paste-ready)

All types below live in `packages/app/src/lib/agents/types.ts` and are the single source of truth. Workers MUST import from this module.

```ts
// packages/app/src/lib/agents/types.ts
import type { CoreMessage, LanguageModel, Tool } from 'ai';

// ─────────────────────────────────────────────────────────────────────────────
// AgentDef — parsed + validated agent definition
// ─────────────────────────────────────────────────────────────────────────────

export type AgentColor =
  | 'blue' | 'cyan' | 'green' | 'yellow' | 'magenta' | 'red' | 'white' | 'gray'
  | `#${string}`; // hex fallback

export type AgentEffort = 'low' | 'medium' | 'high' | 'max';
export type AgentMemoryScope = 'none' | 'project' | 'user' | 'local';
export type AgentModelSpec = 'inherit' | string; // 'inherit' or a provider model id

export interface AgentHandoff {
  label: string;
  agent: string;      // target agent name
  prompt: string;     // pre-filled user prompt template
  send?: 'result' | 'none';
}

export interface AgentAutoInvokeRule {
  on: 'file-change' | 'keyword';
  pattern: string;    // glob or regex
}

export interface AgentDef {
  /** Unique name. Matches frontmatter `name:`. MUST be kebab-case, unique across registry. */
  name: string;
  /** Human-readable one-liner used by orchestrator selection + UI. Must include trigger examples. */
  description: string;
  /** Markdown body (everything after the frontmatter fence). Used as the system prompt. */
  systemPrompt: string;

  // ── Model ────────────────────────────────────────────────────────────────
  model: AgentModelSpec;          // default: 'inherit'
  provider?: string;               // optional explicit provider override
  temperature?: number;            // 0..2
  effort?: AgentEffort;

  // ── Tool access ──────────────────────────────────────────────────────────
  /** Allow-list of tool names. `undefined` = inherit all parent tools. `[]` = no tools. */
  tools?: string[];
  /** Deny-list applied after inheritance. */
  toolsDeny?: string[];

  // ── Skills ──────────────────────────────────────────────────────────────
  skills?: string[];

  // ── Delegation ──────────────────────────────────────────────────────────
  /** `undefined` or `[]` = cannot delegate. `['*']` = any registered agent. Otherwise explicit list. */
  agents?: string[];
  /** Max nesting depth this agent is allowed to SPAWN beneath itself. Default 1. */
  maxDepth: number;
  handoffs?: AgentHandoff[];

  // ── Memory ──────────────────────────────────────────────────────────────
  memory: AgentMemoryScope;        // default 'none'

  // ── UI ──────────────────────────────────────────────────────────────────
  color: AgentColor;               // default 'cyan'
  icon: string;                    // single emoji; default '🤖'

  // ── Invocation ──────────────────────────────────────────────────────────
  userInvocable: boolean;          // default true; false = internal-only
  maxTurns: number;                // default 10
  timeoutMs: number;               // default 600_000

  // ── Auto-invoke (not MVP, but typed now) ────────────────────────────────
  autoInvoke?: AgentAutoInvokeRule[];

  // ── Source metadata ─────────────────────────────────────────────────────
  source: 'builtin' | 'user' | 'project';
  sourcePath: string;              // absolute path to the .md file
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentEvent — unified event bus discriminated union
// ─────────────────────────────────────────────────────────────────────────────

export type InvocationId = string;   // ULID
export type AgentName = string;

export interface AgentEventBase {
  /** ULID of the SPECIFIC agent run this event belongs to. */
  invocationId: InvocationId;
  /** Root invocation — all events in a delegation tree share this. UI groups by it. */
  rootInvocationId: InvocationId;
  /** Parent invocation id, or null for the root. */
  parentInvocationId: InvocationId | null;
  /** Agent that emitted this event. */
  agentName: AgentName;
  /** Delegation depth: 1 for the first @mention, 2 for its children, … */
  depth: number;
  /** Monotonic sequence number within this invocation — use for ordering. */
  seq: number;
  /** Wall-clock ms since epoch. */
  ts: number;
}

export type AgentEvent =
  // Lifecycle
  | (AgentEventBase & { type: 'agent:start'; userPrompt: string; model: string })
  | (AgentEventBase & { type: 'agent:end'; finalText: string; usage: { inputTokens: number; outputTokens: number }; durationMs: number })
  | (AgentEventBase & { type: 'agent:error'; error: { code: string; message: string } })
  | (AgentEventBase & { type: 'agent:aborted'; reason: string })
  // Streaming text
  | (AgentEventBase & { type: 'text:delta'; delta: string })
  // Tool calls made BY this agent (not delegations)
  | (AgentEventBase & { type: 'tool:call'; toolCallId: string; toolName: string; args: unknown })
  | (AgentEventBase & { type: 'tool:result'; toolCallId: string; toolName: string; result: unknown; isError: boolean })
  // Delegation edges (emitted on the PARENT invocation)
  | (AgentEventBase & { type: 'delegate:spawn'; childInvocationId: InvocationId; childAgent: AgentName; mode: 'delegate' | 'ask'; prompt: string })
  | (AgentEventBase & { type: 'delegate:return'; childInvocationId: InvocationId; childAgent: AgentName; mode: 'delegate' | 'ask'; summary: string })
  // Shared state writes (for UI inspector; not required for correctness)
  | (AgentEventBase & { type: 'state:set'; key: string; value: unknown })
  | (AgentEventBase & { type: 'state:get'; key: string });

// ─────────────────────────────────────────────────────────────────────────────
// MentionCandidate — unified @ popover type
// ─────────────────────────────────────────────────────────────────────────────

export type MentionCandidate =
  | {
      kind: 'agent';
      /** The literal inserted into the input, e.g. `@planner`. */
      insertText: string;
      /** `planner` — the agent's `name`. */
      name: string;
      /** One-line description extracted from frontmatter `description`. */
      description: string;
      icon: string;
      color: AgentColor;
      source: 'builtin' | 'user' | 'project';
    }
  | {
      kind: 'file';
      /** Literal inserted, e.g. `@src/index.ts`. */
      insertText: string;
      /** Repository-relative path. */
      path: string;
    }
  | {
      kind: 'folder';
      /** Literal inserted, e.g. `@src/`. */
      insertText: string;
      /** Repository-relative path ending in `/`. */
      path: string;
    };

// ─────────────────────────────────────────────────────────────────────────────
// DelegationContext — passed through tool.execute() to enforce depth + ancestry
// ─────────────────────────────────────────────────────────────────────────────

export interface DelegationContext {
  /** The invocation currently executing the tool call. */
  self: {
    invocationId: InvocationId;
    agent: AgentDef;
    depth: number;
  };
  /** Root of the whole tree (depth 1). */
  rootInvocationId: InvocationId;
  /** Linear path from root to self, inclusive, by agent name — used for loop detection. */
  ancestry: AgentName[];
  /** Shared mutable state bag keyed by root invocation. */
  state: Record<string, unknown>;
  /** Event bus to emit AgentEvents on. */
  emit: (event: AgentEvent) => void;
  /** Abort signal propagated from the user's top-level abort. */
  signal: AbortSignal;
  /** The orchestrator — allows tool.execute() to spawn children without importing circularly. */
  orchestrator: IAgentOrchestrator;
  /** Registry handle for agent lookup. */
  registry: IAgentRegistry;
  /** Parent's LanguageModel so children with `model: inherit` reuse it. */
  inheritedModel: LanguageModel;
  /** Parent's tool set so children with `tools: undefined` inherit it (minus `toolsDeny`). */
  inheritedTools: Record<string, Tool>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator + registry interfaces (implemented in .ts files below)
// ─────────────────────────────────────────────────────────────────────────────

export interface IAgentRegistry {
  list(): AgentDef[];
  get(name: string): AgentDef | undefined;
  /** Reload from disk (builtin + ~/.uplnk/agents + .uplnk/agents). Project > user > builtin. */
  reload(projectDir: string | undefined): Promise<void>;
}

export interface RunAgentOptions {
  agent: AgentDef;
  userPrompt: string;
  /** Pre-existing conversation messages (only populated for the root invocation). */
  history?: CoreMessage[];
  parent?: {
    invocationId: InvocationId;
    depth: number;
    ancestry: AgentName[];
    rootInvocationId: InvocationId;
    state: Record<string, unknown>;
    inheritedModel: LanguageModel;
    inheritedTools: Record<string, Tool>;
  };
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
}

export interface RunAgentResult {
  invocationId: InvocationId;
  finalText: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface IAgentOrchestrator {
  run(opts: RunAgentOptions): Promise<RunAgentResult>;
}
```

---

## 2. File Plan

All paths relative to `packages/app/src/`.

| # | Path | Action | Owner | Imports | Contents |
|---|---|---|---|---|---|
| 1 | `lib/agents/types.ts` | **create** | types-worker | `ai` | All types from §1 verbatim. |
| 2 | `lib/agents/registry.ts` | **create** | registry-worker | `fast-glob`, `gray-matter`, `node:fs`, `node:path`, `node:os`, `./types.js`, `./validate.js` | `class AgentRegistry implements IAgentRegistry`. Globs builtin + user + project dirs, parses frontmatter with `gray-matter`, validates via `validate.ts`, merges with project > user > builtin precedence (later wins in a `Map<name, AgentDef>`). Caches the parsed result until `reload()`. |
| 3 | `lib/agents/validate.ts` | **create** | registry-worker | `zod`, `./types.js` | Zod schema for frontmatter; `parseAgentFile(raw: string, sourcePath: string, source): AgentDef`. Applies defaults (maxDepth=1, maxTurns=10, memory='none', color='cyan', icon='🤖', userInvocable=true, timeoutMs=600_000). |
| 4 | `lib/agents/orchestrator.ts` | **create** | orchestrator-worker | `ai` (`streamText`, `tool`, `CoreMessage`), `ulid`, `./types.js`, `./registry.js`, `./delegationTools.js`, `./eventBus.js` | `class AgentOrchestrator implements IAgentOrchestrator`. Builds the per-invocation `DelegationContext`, resolves `inherit` model, merges inherited/allowed/denied tools, assembles `delegate_to_agent`/`ask_agent`/`state_get`/`state_set` tools, invokes `streamText`, pumps events, enforces `maxTurns` via `stopWhen`, and returns `RunAgentResult`. |
| 5 | `lib/agents/delegationTools.ts` | **create** | orchestrator-worker | `ai` (`tool`), `zod`, `./types.js` | `buildDelegationTools(ctx: DelegationContext): Record<string, Tool>`. Exports `makeDelegateTool`, `makeAskTool`, `makeStateTools`. Enforces: allow-list, depth cap, ancestry loop check, registry lookup. `toModelOutput` returns only a string summary. |
| 6 | `lib/agents/eventBus.ts` | **create** | orchestrator-worker | `node:events`, `./types.js` | `class AgentEventBus extends EventEmitter` with typed `emit(event: AgentEvent)` and `on(rootInvocationId, listener)`. Fan-out helper `subscribe(rootId, cb)`. Also exposes a global singleton `getGlobalAgentEventBus()`. |
| 7 | `lib/agents/mentionResolver.ts` | **create** | mention-worker | `./registry.js`, `../fileMention.js`, `./types.js` | `class MentionResolver` with `resolve(query: string, projectDir: string | undefined): MentionCandidate[]`. Returns agents first (matches against `name` and `description`), then folders, then files. Max 30 total. Respects `userInvocable: false`. |
| 8 | `lib/agents/parseUserInput.ts` | **create** | mention-worker | `./registry.js`, `./types.js` | `parseAgentMention(input: string, registry: IAgentRegistry): { agent: AgentDef; prompt: string } \| null`. Matches `/^@([a-z][a-z0-9-]*)\s+(.*)/s` — if first token matches a registered agent name, return it plus the trailing prompt. Otherwise null. |
| 9 | `lib/agents/builtins/planner.md` | exists | — | — | Already exists; no changes. |
| 10 | `lib/agents/builtins/coder.md` | **create** | content-worker | — | See §7. |
| 11 | `lib/agents/builtins/reviewer.md` | **create** | content-worker | — | See §7. |
| 12 | `lib/agents/builtins/tester.md` | **create** | content-worker | — | See §7. |
| 13 | `lib/agents/builtins/researcher.md` | **create** | content-worker | — | See §7. |
| 14 | `lib/agents/builtins/summarizer.md` | **create** | content-worker | — | See §7. |
| 15 | `components/chat/ChatInput.tsx` | **modify** | ui-worker | `../../lib/agents/mentionResolver.js`, `../../lib/agents/types.js` | Replace `MentionState` fields with the variant in §6. Swap candidate source from `filterMentionCandidates` to `MentionResolver.resolve`. Render grouped sections with icons and colors. |
| 16 | `components/chat/AgentEventView.tsx` | **create** | ui-worker | `ink`, `../../lib/agents/types.js` | Renders a single `AgentEvent` stream as an indented, colored block. Props: `{ rootInvocationId, events: AgentEvent[] }`. Groups by `invocationId`, draws a left rail in the agent's color, indents by `depth`. |
| 17 | `hooks/useAgentRun.ts` | **create** | ui-worker | `react`, `../lib/agents/orchestrator.js`, `../lib/agents/eventBus.js`, `../lib/agents/types.js` | Hook exposing `{ events, status, run, abort }`. Internally subscribes to the event bus keyed by a freshly-minted `rootInvocationId`. |
| 18 | `screens/ChatScreen.tsx` | **modify** | integration-worker | `../lib/agents/parseUserInput.js`, `../lib/agents/orchestrator.js`, `../hooks/useAgentRun.js`, `../components/chat/AgentEventView.js` | Detect `@agent` in `handleSubmit`, route to `useAgentRun` instead of `useStream`. Render `AgentEventView` inline in the transcript when the current turn is agent-driven. See §5. |
| 19 | `lib/roles.ts` | **modify** | integration-worker | — | Keep `Role` type for back-compat, but mark `/role` command legacy. No code deletion in this pass. |
| 20 | `lib/agents/__tests__/registry.test.ts` | **create** | tester | `vitest`, `../registry.js` | Builtin discovery, precedence, schema validation, invalid file rejection. |
| 21 | `lib/agents/__tests__/orchestrator.test.ts` | **create** | tester | `vitest`, mock `streamText` | Happy path, delegate_to_agent depth cap, loop detection, ask_agent returns string, `toModelOutput` never leaks full child transcript, abort propagation. |
| 22 | `lib/agents/__tests__/mentionResolver.test.ts` | **create** | tester | `vitest` | Agents-first ordering, `userInvocable:false` hidden, fuzzy match against description. |

Required new dependencies (add to `packages/app/package.json`):
- `gray-matter` — frontmatter parser
- `ulid` — invocation ids
- `fast-glob` — registry discovery (already likely present; verify)

---

## 3. Component Contracts

Workers implement the exact signatures below. No additional exports from these modules.

### 3.1 `AgentRegistry` (`lib/agents/registry.ts`)

```ts
export class AgentRegistry implements IAgentRegistry {
  constructor(opts?: { builtinDir?: string; userDir?: string; projectDir?: string });
  list(): AgentDef[];
  get(name: string): AgentDef | undefined;
  reload(projectDir?: string): Promise<void>;
}

/** Module-level singleton used by ChatScreen. */
export function getAgentRegistry(): AgentRegistry;
```

Discovery order (later overrides earlier by `name`):
1. `packages/app/src/lib/agents/builtins/*.md` (source: `'builtin'`)
2. `~/.uplnk/agents/*.md` (source: `'user'`)
3. `<projectDir>/.uplnk/agents/*.md` (source: `'project'`)

Files that fail Zod validation are skipped with `console.warn`; registry never throws on a single bad file.

### 3.2 `parseAgentFile` (`lib/agents/validate.ts`)

```ts
export function parseAgentFile(
  raw: string,
  sourcePath: string,
  source: 'builtin' | 'user' | 'project',
): AgentDef; // throws on invalid
```

Defaults applied when field absent:
```
model='inherit', maxDepth=1, maxTurns=10, memory='none',
color='cyan', icon='🤖', userInvocable=true, timeoutMs=600_000
```

### 3.3 `AgentOrchestrator` (`lib/agents/orchestrator.ts`)

```ts
export class AgentOrchestrator implements IAgentOrchestrator {
  constructor(deps: {
    registry: IAgentRegistry;
    /** Factory that returns a `LanguageModel` for a given agent model spec. */
    modelFactory: (spec: { model: AgentModelSpec; provider?: string }) => LanguageModel;
    /** Tool set available at the root. Children inherit / filter from this. */
    rootTools: Record<string, Tool>;
    eventBus: AgentEventBus;
  });

  run(opts: RunAgentOptions): Promise<RunAgentResult>;
}
```

`run()` contract:
1. Mint `invocationId = ulid()`.
2. Compute `depth = parent ? parent.depth + 1 : 1`.
3. Compute `ancestry = [...(parent?.ancestry ?? []), agent.name]`.
4. Compute `rootInvocationId = parent?.rootInvocationId ?? invocationId`.
5. Resolve effective model: if `agent.model === 'inherit'`, use `parent.inheritedModel` or the root default.
6. Compute effective tools:
   - Start from `parent?.inheritedTools ?? rootTools`.
   - If `agent.tools` is defined, keep only keys in that list.
   - Remove every key in `agent.toolsDeny`.
   - If `agent.maxDepth > 0` AND `agent.agents && agent.agents.length > 0`, add `delegate_to_agent` and `ask_agent`.
   - Always add `state_get` and `state_set`.
7. Emit `agent:start`.
8. Call `streamText({ model, system: agent.systemPrompt, messages, tools, stopWhen: stepCountIs(agent.maxTurns), abortSignal })`.
9. For each stream event: emit `text:delta`, `tool:call`, `tool:result` with the base fields set.
10. On completion, emit `agent:end` and resolve.
11. On error, emit `agent:error` and reject.
12. On abort, emit `agent:aborted` and reject with `AbortError`.

### 3.4 `buildDelegationTools` (`lib/agents/delegationTools.ts`)

```ts
export function buildDelegationTools(ctx: DelegationContext): Record<string, Tool>;
```

Produces four tools. Each agent run gets its own instances because the closure captures `ctx`.

**`delegate_to_agent`** — full handoff:
```ts
tool({
  description: `Hand off the current task to a specialist agent. Control transfers. Allowed: ${allowedList}`,
  parameters: z.object({
    agent: z.enum(allowedNames as [string, ...string[]]),
    prompt: z.string().describe('Task description for the delegate.'),
  }),
  execute: async ({ agent, prompt }) => {
    enforceDepth(ctx);
    enforceLoop(ctx, agent);
    const child = await ctx.orchestrator.run({
      agent: ctx.registry.get(agent)!,
      userPrompt: prompt,
      parent: {
        invocationId: ctx.self.invocationId,
        depth: ctx.self.depth,
        ancestry: ctx.ancestry,
        rootInvocationId: ctx.rootInvocationId,
        state: ctx.state,
        inheritedModel: ctx.inheritedModel,
        inheritedTools: ctx.inheritedTools,
      },
      signal: ctx.signal,
      emit: ctx.emit,
    });
    ctx.emit({ type: 'delegate:return', /* … */ });
    return { summary: child.finalText };
  },
  toModelOutput: (result) => ({
    type: 'content',
    value: [{ type: 'text', text: result.summary }],
  }),
})
```

**`ask_agent`** — call-and-return with the same signature but a different description (`Call a specialist agent and return here with the result. You keep control.`). Implementation is identical except parent context continues after the tool call — which it already does because `execute()` resolves and `streamText` continues.

The difference between `delegate_to_agent` and `ask_agent` is semantic: both are tool calls that return to the parent. `delegate_to_agent`'s description instructs the model that it SHOULD stop after the delegate returns; `ask_agent` instructs the model to continue. Enforcement is via prompt, not code — this matches Gemini ADK's approach.

**`state_get`** — `{ key: string } -> { value: unknown }`. Reads from `ctx.state`. Emits `state:get`.

**`state_set`** — `{ key: string; value: unknown } -> { ok: true }`. Writes to `ctx.state`. Emits `state:set`.

### 3.5 `MentionResolver` (`lib/agents/mentionResolver.ts`)

```ts
export class MentionResolver {
  constructor(registry: IAgentRegistry);
  resolve(query: string, projectDir: string | undefined): MentionCandidate[];
}
```

Ordering: agents (max 10) → folders (max 10) → files (max 30), filtered total capped at 30. Query matched case-insensitively against: agent `name`+`description`; file/folder path.

### 3.6 `useAgentRun` (`hooks/useAgentRun.ts`)

```ts
export interface UseAgentRunResult {
  events: AgentEvent[];
  status: 'idle' | 'running' | 'done' | 'error';
  run: (agent: AgentDef, prompt: string, history: CoreMessage[]) => Promise<RunAgentResult>;
  abort: () => void;
}
export function useAgentRun(deps: {
  orchestrator: AgentOrchestrator;
  eventBus: AgentEventBus;
}): UseAgentRunResult;
```

Internally: on `run()`, mint a `rootInvocationId`, subscribe the bus filtered by that id, append events to state, call `orchestrator.run()`.

### 3.7 `AgentEventView` component

```tsx
export interface AgentEventViewProps {
  rootInvocationId: InvocationId;
  events: AgentEvent[];
}
export function AgentEventView(props: AgentEventViewProps): JSX.Element;
```

Rendering rules:
- Group by `invocationId`.
- Each group: header line `{icon} @{agentName}` in `agent.color`, then body indented by 2 spaces per `depth`.
- `text:delta` events concatenated into a live text block.
- `tool:call` rendered as `↳ toolName(…)` dim.
- `delegate:spawn` inserts a nested group below the current one.
- `agent:end` closes the block with a dim `✓ finished (<durationMs> ms, <tokens> tok)` line.

---

## 4. Delegation Graph Rules

### 4.1 Tool construction (per-invocation, dynamic)

At `AgentOrchestrator.run()` step 6, delegation tools are added ONLY when:

```
agent.maxDepth > 0
&& agent.agents !== undefined
&& agent.agents.length > 0
&& (ctx.self.depth < ctx.self.agent.maxDepth + rootDepthOffset)
```

The `allowedList` argument used in the tool's Zod enum is:
- If `agent.agents === ['*']`: every name in `registry.list()` where:
  - `def.userInvocable !== false || calledFromAgent` (non-invocable agents can still be called by other agents)
  - `def.name !== agent.name` (no self-recursion)
  - `!ctx.ancestry.includes(def.name)` (no ancestor recursion)
- Else: `agent.agents.filter(n => registry.get(n) && !ctx.ancestry.includes(n))`.

If `allowedList` is empty after filtering, `delegate_to_agent` and `ask_agent` are NOT registered (the model cannot call a tool that does not exist).

### 4.2 Depth enforcement

Two independent limits:
1. **Per-agent cap:** the `maxDepth` frontmatter field on the *current* agent — how many additional levels may nest BELOW it. Checked inside `execute()`:
   ```
   if (ctx.self.depth - rootDepth >= ctx.self.agent.maxDepth) throw new Error('Agent maxDepth exceeded');
   ```
   where `rootDepth` is the depth at which this agent was first invoked.
2. **Hard global cap:** 5. Prevents runaway even if an agent declares `maxDepth: 999`. Enforced in `AgentOrchestrator.run()` step 2:
   ```
   if (depth > 5) throw new Error('Global delegation depth exceeded');
   ```

### 4.3 Loop prevention

`ctx.ancestry` tracks the name chain from root. `execute()` rejects any delegate whose name already appears in the chain. Combined with Zod enum filtering in 4.1, loops are impossible.

### 4.4 Fork isolation

Each spawned child gets a fresh `messages` array — it never sees the parent's `CoreMessage[]`. The only channel between parent and child is:
- The `prompt` string passed into the tool (child input).
- The `summary` returned by `toModelOutput` (parent input).
- The shared `state` dict for explicit, structured handoff.

### 4.5 Context savings via `toModelOutput`

The parent LLM's conversation only ever receives the child's short final summary string, not its streaming text or tool traffic. The full stream is emitted on the event bus for the UI only. This is the single largest context-saver and MUST be preserved.

### 4.6 Abort propagation

The root `AbortSignal` from `useAgentRun.abort()` is threaded through `DelegationContext.signal`. Every child `streamText` call receives the same signal. Cancelling the user's top-level request tears down the whole tree.

### 4.7 Turn cap

Each invocation's `streamText` is wrapped in `stopWhen: stepCountIs(agent.maxTurns)`. Exceeding it emits `agent:end` with a truncation flag in `finalText` (suffix `\n[truncated: maxTurns reached]`).

---

## 5. ChatScreen Integration Points

### 5.1 New state + refs

Add near existing `useStream` / `useConversation` wiring:

```ts
const registry = useMemo(() => getAgentRegistry(), []);
const eventBus = useMemo(() => getGlobalAgentEventBus(), []);
const orchestrator = useMemo(
  () => new AgentOrchestrator({
    registry,
    modelFactory: (spec) =>
      spec.model === 'inherit'
        ? activeModel
        : createLanguageModel({ providerType, baseURL, apiKey, modelId: spec.model }),
    rootTools: mcpTools,
    eventBus,
  }),
  [registry, eventBus, activeModel, providerType, baseURL, apiKey, mcpTools],
);
const agentRun = useAgentRun({ orchestrator, eventBus });
```

### 5.2 `handleSubmit` routing

Before the existing `send(messages, tools, opts)` call:

```ts
const parsed = parseAgentMention(text, registry);
if (parsed !== null) {
  // Persist the user message as usual.
  addMessage({ role: 'user', content: text });
  // Run the agent instead of the normal stream.
  const history = messages; // prior CoreMessages minus the one we just pushed
  await agentRun.run(parsed.agent, parsed.prompt, history);
  // Persist the assistant-side transcript as a synthetic assistant message
  // (concatenation of root invocation's text:delta events, produced by a helper).
  return;
}
```

### 5.3 Rendering

Insert `<AgentEventView>` into the transcript when `agentRun.status !== 'idle'`. When it completes, convert the accumulated root-level text into a normal assistant `CoreMessage` and store via `appendAssistantToState`. The live `AgentEventView` replaces the `<StreamingMessage>` for this turn.

```tsx
{agentRun.status !== 'idle' ? (
  <AgentEventView rootInvocationId={agentRun.rootInvocationId} events={agentRun.events} />
) : (
  <StreamingMessage text={streamedText} status={status} activeToolName={activeToolName} />
)}
```

### 5.4 Abort wiring

The existing Ctrl+C abort (in ChatScreen's `useInput`) must call `agentRun.abort()` when `agentRun.status === 'running'`, otherwise `abort()` from `useStream`.

### 5.5 What does NOT change

- `useConversation`, `addMessage`, DB persistence paths — agent runs appear as one user message + one synthesized assistant message.
- `/role`, `/model`, `/compact` commands — untouched.
- Non-agent submissions — unchanged path.

---

## 6. `@` Mention Popover Changes

### 6.1 `MentionState` extension

In `ChatInput.tsx`, replace the existing `MentionState`:

```ts
interface MentionState {
  active: boolean;
  startIdx: number;
  query: string;
  cursor: number;
  /** Full grouped candidate list from MentionResolver. */
  candidates: MentionCandidate[];
}
```

### 6.2 Candidate source

Replace:
```ts
const candidates = useMemo(() => (projectDir ? listMentionCandidates(projectDir) : []), [projectDir]);
const filtered  = useMemo(() => (mention.active ? filterMentionCandidates(candidates, mention.query, 50) : []), ...);
```
With:
```ts
const resolver = useMemo(() => new MentionResolver(getAgentRegistry()), []);
const filtered = useMemo(
  () => (mention.active ? resolver.resolve(mention.query, projectDir) : []),
  [resolver, mention.active, mention.query, projectDir],
);
```

### 6.3 Popover rendering

The popover renders three sections — each omitted if empty — separated by a dim header row:

```
Agents
  ▶ 🗺️  @planner        Plan and orchestrate multi-step tasks
    🔍  @researcher     Deep research and source gathering
Folders
    📁  src/components/
Files
    📄  src/index.tsx
    📄  packages/app/src/screens/ChatScreen.tsx

  ↑↓ select · Enter insert · Esc cancel
```

Agent rows colored with `candidate.color`. File/folder rows use dim. Cursor selection (`▶`) spans all sections as a single flat index into `filtered`.

### 6.4 Insertion

When Enter commits a candidate:
- `kind: 'agent'` → insert `@<name> ` (space-terminated). The agent name is inserted raw (no brackets) so `parseAgentMention` can pick it up from plain text.
- `kind: 'file'` → insert `@<path> ` as today.
- `kind: 'folder'` → insert `@<path>/ ` (trailing slash).

The existing `{@...}` tagged-line highlighter in `renderTaggedLine` already colors `@`-prefixed spans; extend its regex branch so agent names (known via a small in-component `Set<string>` of agent names rebuilt from the registry on mount) render in the agent's color. Workers: keep it simple — if the inserted text's first token is in the agent name set, color it cyan (`#22D3EE`); file paths keep today's blue/cherry rules.

### 6.5 `@` trigger rule

Current code only opens the popover when the `@` is at end-of-value and preceded by space or start. Keep that rule. No change.

---

## 7. New Builtin Agents

All files go in `packages/app/src/lib/agents/builtins/`. Frontmatter MUST conform to §1.

### 7.1 `researcher.md`

```md
---
name: researcher
description: |
  Deep research and source gathering specialist. Use when a question requires reading
  many files, cross-referencing documentation, or building a factual brief before any
  implementation. Does not write code; produces structured findings.

  <example>
  Context: User needs background before a refactor
  user: "@researcher how is authentication currently wired through the app?"
  assistant: "I'll trace the auth flow across the codebase and produce a map."
  <commentary>
  Pure investigation — researcher reads and reports, does not change files.
  </commentary>
  </example>

model: inherit
color: magenta
icon: 🔎
agents: []
maxDepth: 0
maxTurns: 12
tools: [Read, Grep, Glob]
userInvocable: true
---

You are a senior research analyst. Your job is to investigate the codebase and produce a structured, citation-backed brief.

## Responsibilities
- Read widely and precisely — use Grep/Glob to survey, then Read to confirm
- Cite every claim with a file path and line range
- Surface contradictions and unknowns explicitly
- Never modify files

## Process
1. Restate the question in one sentence
2. Produce a search plan (files, symbols, patterns)
3. Execute reads in parallel where possible
4. Assemble findings as a numbered list with citations
5. End with an "Unknowns" section listing what you could not confirm

## Output Format
- **Question**: restated
- **Findings**: numbered, each ending with `(path:lines)`
- **Map**: optional ASCII diagram of the relevant subsystem
- **Unknowns**: bullet list

## What You Do Not Do
- Edit, create, or delete files
- Propose implementation changes (delegate back to @planner for that)
```

### 7.2 `summarizer.md`

```md
---
name: summarizer
description: |
  Condenses long transcripts, diffs, or research briefs into short, faithful summaries.
  Use when context is large and downstream agents need a compact version. Produces
  bullet-point summaries under a fixed word budget.

  <example>
  Context: A research brief needs to be handed to the coder in compact form
  user: "@summarizer compress the findings above into 5 bullets for @coder"
  assistant: "Here are the 5 most actionable points."
  <commentary>
  Pure compression — no new information, no opinions.
  </commentary>
  </example>

model: inherit
color: yellow
icon: 📝
agents: []
maxDepth: 0
maxTurns: 3
tools: []
userInvocable: true
temperature: 0.2
---

You are a ruthless summarizer. Your job is to compress input into the smallest faithful representation.

## Rules
- Never invent facts
- Never add opinions
- Preserve every concrete identifier (file path, function name, error code)
- Default budget: 5 bullets, max 25 words each, unless the user specifies otherwise

## Output Format
- `- <bullet>` lines only
- No preamble, no closing remarks
```

### 7.3 `coder.md`, `reviewer.md`, `tester.md` (brief specs — content-worker fills in body text following the template)

| Field | coder | reviewer | tester |
|---|---|---|---|
| color | green | red | blue |
| icon | 🛠️ | 🔍 | 🧪 |
| model | inherit | inherit | inherit |
| agents | [] | [] | [] |
| maxDepth | 0 | 0 | 0 |
| maxTurns | 20 | 8 | 10 |
| tools | undefined (inherit all) | [Read, Grep, Glob] | undefined (inherit all) |
| userInvocable | true | true | true |
| temperature | omit | 0.3 | omit |

Body prompts follow the structure of `planner.md`: Responsibilities / Process / Output Format / What You Do Not Do. Keep under 50 lines each.

---

## 8. Implementation order (suggested)

1. `types.ts` (§1) — unblocks everyone.
2. `validate.ts` + `registry.ts` + tests (§3.1–3.2).
3. `eventBus.ts` (§2 file 6).
4. `delegationTools.ts` + `orchestrator.ts` + tests (§3.3–3.4, §4).
5. `parseUserInput.ts` + `mentionResolver.ts` + tests (§3.5, §6).
6. `useAgentRun.ts` + `AgentEventView.tsx` (§3.6–3.7).
7. `ChatInput.tsx` popover changes (§6).
8. `ChatScreen.tsx` routing (§5).
9. New builtin agent markdown files (§7).
10. End-to-end manual test: `@planner design the auth module`.

---

## 9. Non-goals (explicitly out of scope for this pass)

- `autoInvoke` runtime (type is defined; no detector yet).
- Agent memory persistence (`memory: project|user|local`) — type is defined, reader is a stub that returns `""`.
- `skills:` loader.
- Agent hot-reload on file change (manual `registry.reload()` only).
- UI for inspecting the `state` dict (events are emitted, but no viewer yet).

Workers: do not implement any of these.
