# Multi-Agent Role System — Implementation Plan

> Authoritative blueprint for all work on the uplnk agent system.
> Read this before writing any code related to agents, roles, skills, or @mention.

## Status

- Phase 1: **not started**
- Phase 2: not started
- Phase 3: not started
- Phase 4: not started

---

## Goal

Add a multi-agent role system where users can:

- `@role_name` mention a role in chat to invoke it as a subagent
- Roles can delegate to other roles: `@planner orchestrate this, delegate to @coder and verify with @reviewer`
- Each role has: name, description, model override, tool subset, skills, system prompt
- Roles are defined as `.md` files with YAML frontmatter
- Results from each sub-role stream back into the main chat as distinct labeled messages
- Skills are reusable knowledge packages attachable to roles
- All user-level config lives in `~/.uplnk/`

---

## File Format

Agents are `.md` files with YAML frontmatter. The markdown body is the system prompt.

See the template at: `packages/app/src/lib/agents/builtins/template.md`

### Required fields
- `name` — kebab-case identifier, `^[a-z][a-z0-9-]*$`, max 64 chars
- `description` — when to use this agent; the orchestrator reads this for automatic delegation; include `<example>` blocks

### Optional fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `model` | string | `inherit` | `inherit` or any provider model id |
| `provider` | string | inherit | explicit provider override |
| `temperature` | number | inherit | 0.0–2.0 |
| `effort` | string | inherit | `low`, `medium`, `high`, `max` |
| `tools` | string[] | inherit all | allowlist of tool names; supports `*`, `mcp_*`, `mcp_<server>_*` wildcards |
| `toolsDeny` | string[] | none | denylist applied after allowlist |
| `mcpServers` | string[] | inherit | subset of McpManager server ids |
| `skills` | string[] | none | skill names to preload into system prompt |
| `memory` | string | `none` | `project`, `user`, `local` |
| `agents` | string[] or `"*"` | `[]` | which sub-agents this agent may invoke |
| `handoffs` | Handoff[] | none | structured delegation targets |
| `maxTurns` | number | 10 | inner step limit |
| `maxDepth` | number | 3 | max delegation nesting (hard cap 8) |
| `timeoutMs` | number | 600000 | 10 minutes |
| `color` | string | none | named color or hex for AgentCard badge |
| `icon` | string | none | single emoji |
| `userInvocable` | boolean | true | can user @mention directly |
| `autoInvoke` | AutoInvokeRule[] | none | conditions for automatic invocation |
| `permissionMode` | string | `default` | `default`, `acceptEdits`, `auto`, `readonly` |

### Handoff shape
```yaml
handoffs:
  - label: "Run Tests"
    agent: tester
    prompt: "Run the test suite against the changes above"
    send: result
```

### AutoInvoke shape
```yaml
autoInvoke:
  - on: file-change
    pattern: "**/auth/**"
  - on: keyword
    pattern: "security|vulnerability|CVE"
```

---

## Directory Structure

### User-level (applies to all projects)
```
~/.uplnk/
├── config.json          # already exists
├── agents/
│   └── *.md
└── skills/
    └── <skill-name>/
        └── SKILL.md
```

### Project-level
```
<project>/
└── .uplnk/
    ├── agents/
    │   └── *.md
    └── skills/
        └── <skill-name>/
            └── SKILL.md
```

Precedence (highest → lowest): project `.uplnk` > user `.uplnk` > builtins

---

## New Modules to Create

All in `packages/app/src/lib/agents/`:

| File | Responsibility |
|---|---|
| `types.ts` | `AgentDefinition`, `SkillDefinition`, `AgentInvocation`, `AgentResult`, `AgentFrontmatter` TypeScript interfaces |
| `schema.ts` | Zod validation schema for frontmatter |
| `parser.ts` | Parse a `.md` file → `AgentDefinition` (gray-matter + Zod) |
| `AgentRegistry.ts` | Scan directories, cache definitions, hot-reload via chokidar |
| `SkillRegistry.ts` | Same for SKILL.md files |
| `AgentOrchestrator.ts` | Invoke agents, stream results, handle delegation |
| `builtins/template.md` | Blank template |
| `builtins/planner.md` | Built-in planner agent |
| `builtins/coder.md` | Built-in coder agent |
| `builtins/reviewer.md` | Built-in reviewer agent |

New hook: `packages/app/src/hooks/useAgents.ts`

New component: `packages/app/src/components/chat/AgentCard.tsx`

---

## TypeScript Interfaces

```typescript
// packages/app/src/lib/agents/types.ts

export interface AgentFrontmatter {
  name: string;
  description: string;
  model?: 'inherit' | string;
  provider?: string;
  temperature?: number;
  effort?: 'low' | 'medium' | 'high' | 'max';
  tools?: string[];
  toolsDeny?: string[];
  mcpServers?: string[];
  skills?: string[];
  memory?: 'project' | 'user' | 'local' | 'none';
  agents?: string[] | '*';
  handoffs?: Handoff[];
  maxTurns?: number;
  maxDepth?: number;
  timeoutMs?: number;
  color?: string;
  icon?: string;
  userInvocable?: boolean;
  autoInvoke?: AutoInvokeRule[];
  permissionMode?: 'default' | 'acceptEdits' | 'auto' | 'readonly';
  kind?: 'local' | 'remote';
}

export interface Handoff {
  label: string;
  agent: string;
  prompt?: string;
  send?: 'messages' | 'summary' | 'result';
  model?: string;
}

export interface AutoInvokeRule {
  on: 'file-change' | 'pre-commit' | 'slash' | 'keyword';
  pattern?: string;
}

export type AgentScope = 'builtin' | 'user' | 'project';

export interface AgentDefinition {
  id: string;                   // `${scope}:${name}`
  name: string;
  scope: AgentScope;
  sourcePath: string;
  frontmatter: AgentFrontmatter;
  systemPrompt: string;
  checksum: string;
  loadedAt: number;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  sourcePath: string;
  scope: 'user' | 'project' | 'builtin';
  body: string;
  triggers?: string[];
}

export interface AgentInvocation {
  id: string;
  conversationId: string;
  agentId: string;
  parentInvocationId: string | null;
  depth: number;
  triggeredBy: 'user-mention' | 'agent-mention' | 'handoff' | 'slash' | 'auto';
  input: string;
  contextMessageIds: string[];
  toolNames: string[];
  status: 'pending' | 'running' | 'streaming' | 'done' | 'error' | 'cancelled' | 'timeout';
  startedAt: number;
  finishedAt?: number;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
}

export interface AgentResult {
  invocationId: string;
  agentId: string;
  text: string;
  toolCalls: Array<{ name: string; args: unknown; result?: unknown }>;
  childInvocationIds: string[];
  handoffRequests: Handoff[];
  summary?: string;
}
```

---

## DB Migration

File: `packages/db/migrations/0005_agents.sql`
Must be registered in: `packages/db/migrations/meta/_journal.json`

```sql
CREATE TABLE agent_invocations (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL,
  agent_name      TEXT NOT NULL,
  parent_id       TEXT REFERENCES agent_invocations(id),
  depth           INTEGER NOT NULL DEFAULT 0,
  triggered_by    TEXT NOT NULL,
  input           TEXT NOT NULL,
  status          TEXT NOT NULL,
  model           TEXT,
  tool_names      TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  error           TEXT
);

CREATE INDEX idx_agent_inv_conv ON agent_invocations(conversation_id);
CREATE INDEX idx_agent_inv_parent ON agent_invocations(parent_id);

ALTER TABLE messages ADD COLUMN agent_invocation_id TEXT
  REFERENCES agent_invocations(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN agent_name TEXT;
ALTER TABLE messages ADD COLUMN agent_color TEXT;

CREATE TABLE agent_memory (
  project_hash    TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  scope           TEXT NOT NULL,
  body            TEXT NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (project_hash, agent_id, scope)
);

CREATE TABLE agent_tool_audit (
  id              TEXT PRIMARY KEY,
  invocation_id   TEXT NOT NULL REFERENCES agent_invocations(id) ON DELETE CASCADE,
  tool_name       TEXT NOT NULL,
  args            TEXT NOT NULL,
  result_summary  TEXT,
  allowed         INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
```

---

## McpManager Change

Add to `packages/app/src/lib/mcp/McpManager.ts`:

```typescript
export interface ToolFilter {
  allow?: string[];
  deny?: string[];
  mcpServers?: string[];
}

getAiSdkToolsFiltered(filter: ToolFilter): Record<string, Tool>;
```

---

## ChatInput Change

Refactor `packages/app/src/components/chat/ChatInput.tsx` to a `MentionProvider` abstraction:

```typescript
type MentionKind = 'file' | 'agent' | 'skill';

interface MentionProvider {
  kind: MentionKind;
  search(query: string): MentionCandidate[];
}

interface MentionCandidate {
  kind: MentionKind;
  label: string;
  detail?: string;
  color?: string;
  insertText: string;
}
```

Unified `@` popover with sections: Agents → Files → Skills. No separate sigils.

---

## ChatScreen Change

`packages/app/src/screens/ChatScreen.tsx`:

1. Add `const agents = useAgents()`
2. Pass `[agentsProvider, filesProvider, skillsProvider]` to ChatInput
3. In `onSubmit(text)`: if first token is `@agent`, route to `agents.invoke(name, rest)` instead of `useStream.send`
4. Subscribe to orchestrator events → `appendAgentMessage(invocationId, agentId, delta)`

**Critical:** `useStream` stays untouched. `AgentOrchestrator` calls `streamText` directly.

---

## Orchestration Flow

```
User submits "@planner design the auth module"
  │
  ▼
ChatScreen.onSubmit()
  ├── parseMentions("@planner design...") → [{kind:'agent', name:'planner'}]
  ├── agents.invoke('planner', 'design the auth module', depth:0)
  │     │
  │     ▼
  │   AgentOrchestrator.invoke()
  │     ├── registry.resolve('planner') → AgentDefinition
  │     ├── cycle check (ancestry lineage)
  │     ├── depth check (≤ maxDepth)
  │     ├── buildSystemPrompt(agent + skills + memory)
  │     ├── mcp.getAiSdkToolsFiltered(agent.tools, agent.toolsDeny)
  │     ├── resolveModel(agent.model)  ← 'inherit' = root model snapshot
  │     ├── persistInvocation(status:'pending')
  │     ├── streamText({ system, messages, tools, model })
  │     │     └── onChunk → onEvent('delta') → appendAgentMessage()
  │     ├── onFinish: detectDelegations(resultText)
  │     │     └── for each @mention or delegate_to_agent call → invoke() recursively
  │     ├── saveMemory()
  │     └── persistInvocation(status:'done')
  │
  └── AgentCard appears in MessageList with agent name + color badge
```

---

## Delegation Rules

- Agents can only invoke agents listed in their `agents` field (or `"*"`)
- Detection: scan `onFinish` text for `@agent-name` OR `delegate_to_agent` tool call
- Cycle prevention: walk `parentInvocationId` chain; reject if agent already in ancestry
- Hard depth cap: 8
- Per-turn budget: max 20 invocations per root user message

---

## Implementation Phases

### Phase 1 — MVP
Deliverable: user can `@agent` in chat, agent runs, result appears inline.

**Depth rule for Phase 1:** max depth = 1 (no subagent may spawn another subagent). Unlock in Phase 2 after cycle detection is in place.

- [ ] `types.ts`, `schema.ts`, `parser.ts`
- [ ] `AgentRegistry` (project + user + builtins; no watcher yet)
- [ ] `AgentOrchestrator.invoke` (single-level, depth = 1 hard-enforced)
- [ ] `McpManager.getAiSdkToolsFiltered` (supports `*`, `mcp_*`, `mcp_<server>_*` wildcards)
- [ ] `useAgents` hook
- [ ] ChatInput MentionProvider refactor + agents provider
- [ ] ChatScreen routing for `@agent` first-token
- [ ] DB migration 0005 (invocations + message columns; skip memory/audit)
- [ ] Minimal `AgentCard` (name + color badge, live token stream)
- [ ] Tool-call approval dialogs always surface at root UI (never nested)
- [ ] 4 builtins: `planner.md`, `coder.md`, `reviewer.md`, `tester.md`

### Phase 2 — Delegation & Skills
- [ ] `delegate_to_agent` synthetic tool + inline @mention detection
- [ ] Cycle detection, depth limits, per-turn budget
- [ ] `SkillRegistry` + skill loading into system prompt
- [ ] `/agents` slash command tree (`list`, `show`, `reload`)
- [ ] chokidar hot reload

### Phase 3 — Memory, Handoffs, UI
- [ ] `agent_memory` table + load/save in orchestrator
- [ ] Structured `handoffs` frontmatter handling
- [ ] `/agents tree` live DAG view (Ink)
- [ ] `/agents edit`, `/agents new` with template scaffolding
- [ ] AgentCard with token counts, status spinner, tool-call list
- [ ] Replay: `/agents replay <invocationId>`

### Phase 4 — autoInvoke & Polish
- [ ] `autoInvoke` rules engine
- [ ] `toolsDeny` + `mcpServers` subset enforcement
- [ ] Skill BM25 trigger index + suggestion UI
- [ ] Config migration: old `/role` strings → `~/.uplnk/agents/<slug>.md`

---

## Design Decisions (resolved)

1. `model: inherit` resolves to the model active at root invocation start (snapshot). **Rationale:** reproducibility.
2. Sub-agent tool calls get their own 100-call budget per invocation, not the main conversation's. **Rationale:** agent activity should not burn the user's quota.
3. MVP streaming: sub-agent deltas appear live in the main transcript.
4. `tools: inherit` means parent agent's filtered tools, not root conversation's tools. **Rationale:** enables layered restriction.
5. Context isolation: each subagent gets a fresh `messages[]` seeded with (system prompt + delegation prompt) only. Parent conversation history is never passed. **Rationale:** token economy, no accidental context bleed.
6. `tools:` field supports wildcards: `*` (all), `mcp_*` (all MCP tools), `mcp_<server>_*` (one server's tools). **Rationale:** avoids enumerating every tool name.
7. Approval dialogs (even from deep subagents) queue at the root Ink UI layer. **Rationale:** single approval surface, no nested prompts.
8. No inline `mcpServers` per agent file. MCP servers are global config; agents reference them by name via `tools: [mcp_<server>_*]`. **Rationale:** no secret duplication, no per-file MCP lifecycle.
9. Phase 1 depth cap = 1 (flat). Phase 2+ unlocks `maxDepth` after cycle detection is implemented. **Rationale:** ship safely first.
