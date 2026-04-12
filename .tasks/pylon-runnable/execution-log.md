# Execution Log — pylon-runnable

## [2026-04-12T03:15:35.709Z] Phase 1: Generate DB migrations and wire runMigrations into app startup -- @data-engineer
Server-recorded completion (agent did not write log entry).

## [2026-04-12T06:15:00Z] Phase 1: Generate DB migrations and wire runMigrations into app startup — @data-engineer

### What was done

1. **Generated Drizzle migration** via `pnpm --filter pylon-db db:generate`. Produced `packages/db/migrations/0000_many_lethal_legion.sql` with all 4 tables (provider_configs, conversations, messages, artifacts), CHECK constraints, indexes, foreign keys, and ISO timestamp defaults. Journal file at `packages/db/migrations/meta/_journal.json`.

2. **Wired `runMigrations()` into `packages/app/bin/pylon.ts`**. Added `import { runMigrations } from 'pylon-db'` at top and `runMigrations()` call after the `doctor` early-exit block but before `render()`. Migrations run synchronously before the Ink TUI starts.

3. **Created `packages/db/src/queries.ts`** with all typed query functions:
   - Conversations: createConversation, getConversation, listConversations, updateConversationTitle, softDeleteConversation, touchConversation
   - Messages: insertMessage, getMessages
   - Provider configs: upsertProviderConfig, getDefaultProvider, listProviders
   - All functions take `db: Db` as first argument for testability
   - Added `export * from './queries.js'` to `packages/db/src/index.ts`

4. **Typecheck passes** across all 3 workspace packages (pylon-db, pylon-shared, pylon-app) with zero errors.

### Files created
- `packages/db/migrations/0000_many_lethal_legion.sql`
- `packages/db/migrations/meta/_journal.json`
- `packages/db/migrations/meta/0000_snapshot.json`
- `packages/db/src/queries.ts`

### Files modified
- `packages/app/bin/pylon.ts` (added runMigrations import and call)
- `packages/db/src/index.ts` (added queries re-export)

### Handoff notes for downstream phases
- Phase 3 (useConversation hook) can import query functions directly: `import { createConversation, insertMessage, getMessages, ... } from 'pylon-db'`
- The `Db` type is exported from `pylon-db` for dependency injection in tests
- `upsertProviderConfig` uses onConflictDoUpdate keyed on `providerConfigs.id`
- `softDeleteConversation` sets `deletedAt` to ISO timestamp; `listConversations` filters on `isNull(deletedAt)`

## [2026-04-12T03:18:50.275Z] Phase 2: Implement config system (src/lib/config.ts) with Zod + defaults -- @staff-engineer
Server-recorded completion (agent did not write log entry).

## [2026-04-12T00:00:00.000Z] Phase 2: Implement config system (src/lib/config.ts) with Zod + defaults — @staff-engineer

Created `/packages/app/src/lib/config.ts` with:
- `ConfigSchema` (Zod, version 1, optional defaultProviderId/defaultModel, theme enum defaulting to 'dark')
- `Config` type exported
- `getConfigPath()` — delegates to `getPylonDir()` from pylon-db
- `loadConfig()` — safeParse with catch-all; returns undefined on missing file or invalid JSON/schema
- `saveConfig()` — mkdirSync recursive before write; JSON.stringify with 2-space indent
- `seedDefaultProvider()` — idempotent; inserts 'ollama-local' only when no default provider row exists
- `getOrCreateConfig()` — seeds provider then returns existing config, or creates default, seeds, writes, returns

`DEFAULT_CONFIG` typed with `satisfies z.input<typeof ConfigSchema>` so exactOptionalPropertyTypes is satisfied (optional keys absent rather than set to undefined). Uses `ConfigSchema.parse(DEFAULT_CONFIG)` to get the fully-typed output (with Zod-applied defaults like `theme`) before saving.

All three packages typecheck clean with zero errors.

## [2026-04-12T03:22:37.970Z] Phase 4: Implement useModelSelector hook — fetch live models from Ollama /api/tags -- @nexus
Server-recorded completion (agent did not write log entry).

## [2026-04-12T12:01:00Z] Phase 4: Implement useModelSelector hook — fetch live models from Ollama /api/tags — @nexus

### What was done

Created `packages/app/src/hooks/useModelSelector.ts` — a React hook that fetches the live model list from Ollama's `/api/tags` endpoint.

**Exported interface:** `UseModelSelectorResult` with `models: string[]`, `isLoading: boolean`, `error: string | null`, `refresh: () => void`.

**Hook:** `useModelSelector(baseUrl?)` — defaults to `http://localhost:11434`. Uses `.then/.catch/.finally` promise chain (not async/await) inside a `useCallback` to avoid ESLint floating-promise warnings in `useEffect`. Fetches on mount and when `baseUrl` changes. The `refresh` function allows manual re-fetching.

**Design notes:**
- Internal `OllamaModel` and `OllamaTagsResponse` interfaces are not exported — only the result interface is public
- `res.json()` cast via `as Promise<OllamaTagsResponse>` since this is a trusted local Ollama API
- Error handling: catches both network errors and non-OK HTTP statuses
- No `exactOptionalPropertyTypes` concerns — all fields in the result interface are required

**Typecheck:** All 3 workspace packages (pylon-db, pylon-shared, pylon-app) pass with zero errors.

### Files created
- `packages/app/src/hooks/useModelSelector.ts`

### Handoff notes for downstream phases
- Phase 5 (nexus): config system already exists at `packages/app/src/lib/config.ts`; `baseUrl` can be sourced from config and passed to `useModelSelector(baseUrl)`
- Phase 7 (vesper): import `useModelSelector` from `../hooks/useModelSelector.js` in `ModelSelectorScreen.tsx`; replace `PLACEHOLDER_MODELS` with `models` from the hook; use `isLoading` for a loading indicator and `error` for error display

## [2026-04-12T03:23:15.958Z] Phase 3: Implement useConversation hook — create/load/persist messages in SQLite -- @data-engineer
Server-recorded completion (agent did not write log entry).

## [2026-04-12T12:05:00Z] Phase 3: Implement useConversation hook — create/load/persist messages in SQLite — @data-engineer

### What was done

Created `packages/app/src/hooks/useConversation.ts` with the following API:

- **`useConversation(resumeId?: string): UseConversationResult`** — React hook that manages a conversation's lifecycle in SQLite.
- On mount: creates a new conversation (with `crypto.randomUUID()` for the id) or loads an existing one if `resumeId` is provided.
- **`addMessage(data: AddMessageData): Message | null`** — persists a message to DB via `insertMessage`, appends to local `messages` state, and calls `touchConversation` to bump the conversation's `updatedAt` timestamp. Returns `null` if conversation is not yet initialized.
- **`AddMessageData`** type is `Omit<NewMessage, 'id' | 'conversationId' | 'createdAt'>` — caller provides `role` (required) and optionally `content`, `toolCalls`, `toolCallId`, `inputTokens`, `outputTokens`, `timeToFirstToken`.
- **`isReady`** boolean signals when initialization is complete (set to `true` after the effect runs, regardless of whether resume succeeded).

### Typecheck

All 3 workspace packages (pylon-db, pylon-shared, pylon-app) pass `tsc --noEmit` with zero errors.

### Handoff notes for Phase 6

- Import: `import { useConversation } from '../hooks/useConversation.js'` (or wherever ChatScreen lives relative to hooks)
- The hook returns `{ conversationId, messages, addMessage, isReady }`.
- `addMessage` is stable (useCallback with `[conversationId]` dep) so it's safe to pass as a prop.
- `messages` is the full ordered array from DB on mount, then appended to in-memory on each `addMessage` call.
- If `resumeId` references a conversation that doesn't exist, the hook sets `isReady: true` but `conversationId` remains `null` — the consumer should handle this (e.g., fall back to creating a new conversation).

## [2026-04-12T03:27:39.138Z] Phase 7: Wire live models from useModelSelector into ModelSelectorScreen -- @vesper
Server-recorded completion (agent did not write log entry).

## [2026-04-12T00:00:00Z] Phase 7: Wire live models from useModelSelector into ModelSelectorScreen — @vesper

Replaced PLACEHOLDER_MODELS with live data from useModelSelector hook.

Changes to packages/app/src/screens/ModelSelectorScreen.tsx:
- Removed PLACEHOLDER_MODELS constant and the comment marking it as a placeholder
- Added import of useModelSelector from '../hooks/useModelSelector.js'
- Destructured { models, isLoading, error } from useModelSelector()
- useInput guard now skips navigation/selection when isLoading or models.length === 0
- models[cursor] access guarded with `if (model !== undefined)` for noUncheckedIndexedAccess compatibility
- Render tree covers all four states:
  1. Loading: dimColor "Fetching models…" spinner text
  2. Error: red "Error: <message>" (conditioned on error !== null, not just truthiness)
  3. Empty: dimColor "No models found. Is Ollama running?"
  4. Populated: keyed list with cursor highlight via conditional spread (exactOptionalPropertyTypes safe)

pnpm typecheck passes clean (packages/shared, packages/db, packages/app — no errors).

## [2026-04-12T03:28:10.607Z] Phase 5: Wire config into ChatScreen provider, replace hardcoded localhost -- @nexus
Server-recorded completion (agent did not write log entry).

## [2026-04-12T03:28:10.607Z] Phase 6: Wire useConversation into ChatScreen; replace in-memory state with DB -- @staff-engineer
Server-recorded completion (agent did not write log entry).

## [2026-04-12T00:00:00Z] Phase 5: Wire config into ChatScreen provider, replace hardcoded localhost — @staff-engineer
Replaced the hardcoded `createDefaultModel` helper (which always used `http://localhost:11434/v1`)
with a ref-based one-time init that calls `getDefaultProvider(db)` and falls back to the same URL
only if no provider row exists. Config is loaded via `getOrCreateConfig()` (also ref-gated so it
runs exactly once). `createOpenAICompatible` now receives `baseURL` and `apiKey` from DB. Both
values are concrete strings by the time they reach the call site — no optional-type friction.

## [2026-04-12T00:00:00Z] Phase 6: Wire useConversation into ChatScreen; replace in-memory state with DB — @staff-engineer
Replaced `useState<Message[]>` + manual `crypto.randomUUID()` construction with `useConversation(resumeConversationId)`.
The `addMessage` call in the stream-done effect now persists to SQLite. `handleSubmit` checks `isReady`
before sending. `ChatInput` disabled prop extended to `status === 'streaming' || !isReady`.
Also updated `packages/app/src/index.tsx`: `App` now destructures `resumeConversationId` from `AppProps`
and passes it to `ChatScreen` via conditional spread (`exactOptionalPropertyTypes`-safe pattern).
All three packages typecheck clean with `pnpm typecheck`.
