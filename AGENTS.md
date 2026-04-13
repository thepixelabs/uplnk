# AGENTS.md — uplnk

> Note: This file follows the OpenAI Codex/Agents CLI convention.
> Claude Code reads CLAUDE.md instead. See that file for Claude-specific instructions.

## Project Overview

uplnk is a terminal-native AI chat client. Local-first, privacy-by-architecture, multi-provider. TypeScript + React/Ink (TUI), SQLite via Drizzle ORM, Vercel AI SDK.

**Entry point:** `packages/app/bin/uplnk.ts`
**Node:** ≥20 (pinned at 22.22.2 via Volta)
**Package manager:** pnpm 9.x

## Repository Structure

```
packages/
  app/       TUI application + CLI         @uplnk/app
  db/        Drizzle schema + migrations   @uplnk/db
  shared/    Shared types (UplnkError)     @uplnk/shared
  providers/ Provider abstraction layer   @uplnk/providers
  catalog/   Static model metadata        @uplnk/catalog
```

Dependency direction (enforced): `app → db`, `app → shared`, `app → providers → catalog`.

## Setup

```bash
pnpm install
pnpm build        # compile all packages
pnpm typecheck    # tsc --noEmit (run before submitting changes)
pnpm lint         # ESLint
pnpm test         # unit tests
pnpm test:integration
```

## Agent System

Located in `packages/app/src/lib/agents/`.

### Components

| File | Purpose |
|---|---|
| `orchestrator.ts` | Coordinates agent execution, manages lifecycle state machine |
| `registry.ts` | Agent discovery and metadata lookup |
| `parseUserInput.ts` | Parses `@agent` mention syntax from user messages |
| `delegationTools.ts` | MCP-style tool definitions for agent-to-agent delegation |
| `eventBus.ts` | Pub/sub for agent lifecycle events (start, tool-call, finish, error) |

### Hook

`useAgentRun` in `packages/app/src/hooks/useAgentRun.ts` — React interface to the orchestrator. Subscribes to the event bus and surfaces agent state to the UI.

### Lifecycle Events

Agents emit events through the event bus:
- `agent:start` — agent invoked with input
- `agent:tool-call` — agent dispatched a tool (MCP or delegation)
- `agent:finish` — agent completed with output
- `agent:error` — agent failed with UplnkError

### Agent-to-Agent Delegation

Agents can delegate tasks using `delegationTools.ts`, which wraps sub-agent invocations as MCP-style tool calls. The orchestrator handles routing: local agents resolve via the registry; external agents route through configured MCP servers.

### Mention Syntax

Users can invoke agents with `@agentName` in the chat input. `parseUserInput.ts` extracts mention targets; `ChatInput.tsx` renders autocomplete via the mention resolver.

## Relay Mode (Scout/Anchor)

Relay Mode is a two-phase cost-routing feature, not a separate agent system.

- **Scout phase:** cheap local model (e.g., `qwen2.5:7b`) analyzes the task and produces a brief
- **Anchor phase:** frontier model executes against the brief
- Managed by `useWorkflow` hook + `packages/app/src/lib/workflows/workflowEngine.ts`
- Relay templates stored as JSON in `~/.uplnk/relays/<id>.json`
- Relay execution logged to `relay_runs` table

Relay Mode ≠ Agents. Relay is sequential and linear. Agents support arbitrary delegation graphs.

## MCP Tools Available to Agents

Built-in tools (always enabled):
- `mcp_file_read` — read file contents (path allowlist enforced)
- `mcp_file_list` — list directory contents (path allowlist enforced)

Optional tool (requires config opt-in + user approval per invocation):
- `mcp_command_exec` — execute shell commands

Security constraints applied to all MCP tool calls:
- Paths restricted to `mcp.allowedPaths` in `~/.uplnk/config.json`
- Never-allow commands: `su`, `sudo`, `passwd`, `chsh`, `chfn`, `login`, `adduser`, `deluser`, `userdel`, `groupdel`, `usermod`, `groupmod`
- 30s timeout, 512 KB output cap, shell expansion disabled

## Database Schema (relevant to agents)

Table `agent_runs` tracks agent execution:
- `agent_id` — which agent was called
- `input` — serialized input
- `output` — serialized output
- `tool_calls` — JSON array of tool invocations
- `status` — pending | running | done | error

Query helpers in `packages/db/src/queries.ts`.

## Error Handling

All agent failures should be wrapped in `UplnkError` from `@uplnk/shared`:

```typescript
import { UplnkError, UplnkErrorCode } from '@uplnk/shared';
throw new UplnkError(UplnkErrorCode.MCP_TOOL_ERROR, 'descriptive message', cause);
```

## Testing Agents

- Unit tests in `packages/app/src/__tests__/` or co-located `__tests__/` directories
- Global test setup mocks `os.homedir()` and uses in-memory SQLite
- Coverage target for agent/orchestration code: 75% statements, 70% branches
- Use `vi.mock()` for MCP subprocess isolation

## Commit Conventions

Conventional Commits: `type(scope): summary`
Relevant scopes for agent work: `app`, `mcp`, `agents` (new scope for orchestration changes)
