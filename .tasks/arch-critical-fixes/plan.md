---
epic: arch-critical-fixes
status: DONE
phases:
  - id: 1
    title: "Load config in main() and fail cleanly on invalid config (C4)"
    persona: staff-engineer
    status: DONE
    notes: "loadConfig() now returns LoadConfigResult {ok, config|error}. getOrCreateConfig() propagates error for invalid files. bin/pylon.ts exits with CONFIG_INVALID message before render()."
  - id: 2
    title: "Persist assistant messages incrementally during streaming (C1)"
    persona: staff-engineer
    status: DONE
    notes: "Added updateMessageContent(db, id, content) to queries.ts. useStream now accepts SendOptions.onPersist callback, fired every 500ms and on final flush. useConversation gains addMessageWithId + updateMessageInState. ChatScreen pre-inserts empty assistant row and wires onPersist."
  - id: 3
    title: "Use <Static> for completed messages in ChatScreen (C2)"
    persona: staff-engineer
    status: DONE
    notes: "Completed retroactively as pylon-v05 Phase 0 (P0 fix). MessageList.tsx now uses <Static items={messages}>."
  - id: 4
    title: "MCP: spawn built-in tools as stdio child processes (C3)"
    persona: staff-engineer
    status: DONE
    notes: "Created servers/file-browse.ts and servers/command-exec.ts as standalone stdio MCP servers. McpManager.connectBuiltins() spawns them via StdioClientTransport. Security validation (path check, size limit, command validation, approval gate) runs in parent before forwarding callTool. getAiSdkTools() returns {}; getAiSdkToolsAsync() returns security-wrapped remote tools. ADR-004 satisfied."
---

## Context & Objective

The v01 architecture review (`internal-doc/arch-review.md`) identified four CRITICAL issues that must be fixed before v0.5 feature epics (artifacts v2, project context, multi-provider) begin.

Full prep list with rationale and dependency ordering is in `internal-doc/v05-prep.md`. This plan.md tracks only the CRITICAL items. IMPORTANT and NICE items will be tracked separately.

The four phases below can be parallelized — none depend on each other — but should all land before the v0.5 refactor continues.

### Phase 1 — Config loading in main() (C4)

Files: `packages/app/bin/pylon.ts`, `packages/app/src/screens/ChatScreen.tsx`, `packages/app/src/index.tsx`, `packages/app/src/lib/config.ts`

Problem: `getOrCreateConfig()` runs inside a `useRef` in `ChatScreen.tsx:31`. `loadConfig` returns `undefined` on Zod failure, silently overwriting user config with defaults.

Change:
- `loadConfig` returns `{ ok: true, config } | { ok: false, error }`.
- `bin/pylon.ts` calls it after `runMigrations()`, exits 1 with the Zod error path on failure.
- `<App config={...} providerSettings={...} />` takes both as props.
- Remove `configRef` and `providerRef` from `ChatScreen`.

Test: corrupt `~/.pylon/config.json`; running `pylon` exits cleanly with `CONFIG_INVALID`; the file is NOT overwritten.

### Phase 2 — Incremental assistant persistence (C1)

Files: `packages/app/src/hooks/useStream.ts`, `packages/app/src/screens/ChatScreen.tsx`, `packages/db/src/queries.ts`

Problem: assistant turns exist only in React state until `'streaming' → 'done'`. Mid-stream SIGKILL or error leaves the user row orphaned in SQLite.

Change:
- Add `updateMessageContent(db, id, content)` in `packages/db/src/queries.ts`.
- `ChatScreen.handleSubmit`: insert empty assistant row before `send()`; pass id into `useStream`.
- `useStream.send` accepts `assistantMessageId` and `onPersist(text)`.
- Flush interval calls `onPersist` (debounced ~500 ms). Final flush is synchronous.
- On abort/error, persist buffered text with `{ interrupted: true }` metadata.

Test: SIGKILL mid-stream, reopen conversation, partial assistant text must be visible.

### Phase 3 — `<Static>` for completed messages (C2)

Files: `packages/app/src/screens/ChatScreen.tsx`, `packages/app/src/components/chat/MessageList.tsx`

Problem: every token flush (~30 Hz) re-reconciles the full `MessageList`. `MarkdownMessage.parseMarkdown` is expensive. At 200+ messages this will visibly stutter.

Change:
- `ChatScreen` renders two regions: `<Static items={messages}>{(m) => <MessageItem />}</Static>` and the live region (`<StreamingMessage />`, `<StatusBar />`, `<ChatInput />`).
- `MessageList` as a wrapper goes away.
- Ensure `onPromote` passed to `MessageItem` is reference-stable across renders.
- `<Static>` must not live inside a conditionally-rendered `<Box>` — Ink flushes it on first render only. The split-pane branch must be restructured.

Test: 300-message conversation, stream a new response; no flicker or reflow on older messages.

### Phase 4 — MCP stdio child processes (C3)

Files: `packages/app/src/lib/mcp/McpManager.ts`, `packages/app/src/hooks/useMcp.ts`, plus new `packages/app/src/lib/mcp/servers/{file-browse.ts,command-exec.ts}`

Problem: `buildFileReadTool`, `buildFileListTool`, `buildCommandExecTool` run in-process via `fs` / `execFile`. Violates ADR-004. Kills crash isolation and timeout enforcement. Real security/availability risk when `commandExecEnabled` flips default-on.

Change:
- New `packages/app/src/lib/mcp/servers/file-browse.ts` — stdio MCP server using `@modelcontextprotocol/sdk/server/stdio.js`. Exposes `mcp_file_read`, `mcp_file_list`.
- New `packages/app/src/lib/mcp/servers/command-exec.ts` — stdio MCP server. Exposes `mcp_command_exec`.
- `McpManager.start(serverConfig)` spawns them via `StdioClientTransport`.
- Delete `buildFileReadTool` / `buildFileListTool` / `buildCommandExecTool`; replace with `client.tools()` aggregation.
- Preserve approval flow: wrap the AI-SDK tool so `command_exec` passes through `requestApproval` in the parent BEFORE forwarding the JSON-RPC call.
- Path / command validation (`security.ts`) runs in the parent before forwarding, not in the child.

Test: `ps` shows `file-browse` (and `command-exec` if enabled) as child processes. `kill -9` on a child causes the next tool call to fail with `MCP_PROCESS_FAILED`, not a main-process crash.
