# CLAUDE.md — uplnk

Terminal-native AI chat client. Local-first, privacy-by-architecture, multi-provider. Built with React/Ink (TUI), SQLite via Drizzle, and the Vercel AI SDK.

## Monorepo Layout

pnpm workspace. Strict dependency direction: `app → db → shared`, `app → providers → catalog`.

```
packages/
  app/       Main TUI + CLI entry point  (@uplnk/app)
  db/        Drizzle schema + migrations (@uplnk/db)
  shared/    Shared types + UplnkError   (@uplnk/shared)
  providers/ Provider abstraction layer  (@uplnk/providers)
  catalog/   Static model metadata       (@uplnk/catalog)
```

Entry point: `packages/app/bin/uplnk.ts` — argument parsing, migration run, Ink `render()`.

## Key Commands

```bash
pnpm install          # install all workspace deps
pnpm dev              # run app with tsx (no build step)
pnpm build            # tsup all packages
pnpm typecheck        # tsc --noEmit
pnpm lint             # ESLint
pnpm test             # Vitest unit tests
pnpm test:integration # integration tests (separate config)

make dev              # Volta-pinned equivalent of pnpm dev
make test             # Volta-pinned equivalent of pnpm test
```

## Architecture

### State Management
All business logic lives in React hooks in `packages/app/src/hooks/`. No Redux or Context for core state.

- `useStream` — AI SDK streaming, token accumulation, 33ms flush buffer
- `useConversation` — SQLite persistence, conversation forking, compaction
- `useMcp` — MCP child-process lifecycle, tool dispatch, path allowlist enforcement
- `useWorkflow` — Relay Mode (Scout→Anchor two-phase execution)
- `useAgentRun` — agent delegation, event bus integration

### Database
SQLite at `~/.uplnk/db.sqlite` via `bun:sqlite` (synchronous). Drizzle ORM for type-safe queries. The runtime is Bun (≥ 1.1.30) for both dev and shipped binaries — `bun:sqlite` is the single driver across `pnpm dev`, `pnpm test`, and `bun build --compile` output. There is no Node-side better-sqlite3 path.

Key tables: `conversations`, `messages`, `provider_configs`, `artifacts`, `rag_chunks`, `relay_runs`, `agent_runs`, `secrets`.

Migrations run at startup via `runMigrations()`. Migration SQL lives in `packages/db/migrations/`.

Schema definitions: `packages/db/src/schema.ts`.

### Providers
`ModelProvider` interface in `@uplnk/providers`. Supported kinds: `ollama`, `openai-compatible`, `lmstudio`, `vllm`, `localai`, `llama-cpp`, `anthropic`, `openai`, `custom`.

Factory: `packages/providers/src/factory.ts` — `makeProvider()`.

Live model discovery merges with static catalog via `mergeWithCatalog()`.

### Error Handling
All errors normalize to `UplnkError` with a `UplnkErrorCode` (in `@uplnk/shared`). Use `toUplnkError()` at library boundaries. Crash logs write synchronously to `~/.uplnk/crash.log`.

### MCP Security
- Path allowlist enforced on every file read (`mcp.allowedPaths` in config)
- `mcp_command_exec` disabled by default; requires config opt-in + per-invocation approval dialog
- Never-allow command list in `packages/app/src/lib/mcp/security.ts`
- Subprocess environment stripped; shell expansion disabled; 30s timeout; 512 KB output cap

### Config
`~/.uplnk/config.json` validated with Zod. Schema in `packages/app/src/lib/config.ts`. CLI flags override config. Config is passed as a prop (not Context) — hot-reload requires a refactor.

## Testing Conventions

- Tests co-located in `__tests__/` subdirectories alongside source
- Vitest, `@testing-library/react` with Ink
- Global setup at `packages/app/src/__tests__/setup.ts` — mocks `os.homedir()`, configures in-memory SQLite
- `isolate: true` — fresh module registry per test file
- Coverage thresholds by module: security 95%, core logic 85%, hooks 75%, components 70%
- Environment: `node` (not jsdom — Ink renders to stdout strings)

## Commit Style

Conventional Commits: `type(scope): summary`

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`
Scopes: `app`, `db`, `shared`, `mcp`, `streaming`, `config`, `doctor`, `ci`

## Known Risks / Active Work

- Config passed as prop: future hot-reload needs Context refactor
- Relay engine uses `textStream` not `fullStream` — tool calls in Anchor phase are invisible
- Plugin loader trusts HTTP manifests without signature verification
- No DB schema version check — silent corruption risk on version downgrade
- Relay runs are non-atomic — `relay_runs` row written before `conversations` row
