# Execution Log — arch-critical-fixes

## [2026-04-12T11:00:00Z] Phase 3: <Static> for completed messages (C2) — retroactive DONE — @ceo

Marked DONE retroactively. MessageList.tsx was fixed in pylon-v05 Phase 0 (P0 retroactive fix).
No additional work required.

## [2026-04-12T11:05:00Z] Phase 1: Config loading in main() (C4) — @staff-engineer

Changes applied:
- `packages/app/src/lib/config.ts`: `loadConfig()` now returns `LoadConfigResult = { ok: true; config } | { ok: false; error: string }`. `getOrCreateConfig()` returns the same type; propagates error for corrupt existing files; treats CONFIG_NOT_FOUND as first-run (creates defaults).
- `packages/app/bin/pylon.ts`: Calls `getOrCreateConfig()` after `runMigrations()`, before `render()`. Exits 1 with `CONFIG_INVALID` message if `ok: false`. App component receives `config` prop (typed optional for backward compat).
- `packages/app/src/index.tsx`: `AppProps.config?: Config` added.

Contract: corrupt `~/.pylon/config.json` → `pylon` exits cleanly with Zod error path, file is NOT overwritten.

## [2026-04-12T11:20:00Z] Phase 2: Incremental assistant persistence (C1) — @staff-engineer

Changes applied:
- `packages/db/src/queries.ts`: Added `updateMessageContent(db, id, content)` — UPDATE messages SET content = ? WHERE id = ?.
- `packages/app/src/hooks/useConversation.ts`: Added `addMessageWithId(data)` (accepts caller-supplied id, inserts to DB + updates React state) and `updateMessageInState(id, content)` (updates React state only, no DB write).
- `packages/app/src/hooks/useStream.ts`: Added `SendOptions.onPersist?(text: string): void`. Separate `persistTimerRef` fires every 500ms and on final flush. `accumulatedTextRef` tracks full text for onPersist without stale-closure issues.
- `packages/app/src/screens/ChatScreen.tsx`: `handleSubmit` calls `addMessageWithId({ id: assistantMsgId, role: 'assistant', content: '' })` before `send()`. `onPersist` calls `updateMessageContent(db, assistantMsgId, text)`. On done, `useEffect` calls `updateMessageInState` (no second DB insert).

Contract: SIGKILL mid-stream → reopen conversation → partial assistant text is visible (persisted within last 500ms).
