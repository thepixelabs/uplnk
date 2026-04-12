# Execution Log — pylon-v10

## [2026-04-12T13:44:00Z] Phase 2: Git integration — @staff-engineer

### What was done

Created `packages/app/src/lib/mcp/servers/git.ts` — a standalone stdio MCP server with four git tools using execFile + promisify:
- `mcp_git_status`: runs `git -C <path> status` (read-only)
- `mcp_git_diff`: runs `git -C <path> diff [--staged] [-- filePath]` (read-only)
- `mcp_git_stage`: runs `git -C <path> add -- <paths>` (mutating — requires approval)
- `mcp_git_commit`: runs `git -C <path> commit -m <message>` (mutating — requires approval)

Updated `McpManager.ts`:
- Added `BUILTIN_GIT_ID = '__pylon_builtin_git__'` export
- Added `gitEnabled: boolean` to `McpManagerConfig`
- `connectBuiltins()` spawns git server when `gitEnabled: true`
- Added `wrapGitTools()` private method: validates repoPath against file policy, approval gate for stage/commit, audit log for all four tools
- `getRemoteToolsWithSecurity()` dispatches to `wrapGitTools` for BUILTIN_GIT_ID

Updated `src/lib/config.ts`:
- Added `git: { enabled: z.boolean().default(true) }` to ConfigSchema
- Added `git: { enabled: true }` to DEFAULT_CONFIG

Updated `src/hooks/useMcp.ts`:
- Added `gitEnabled` to `UseMcpOptions`
- Passes `gitEnabled` to `McpManager` constructor

Updated `src/screens/ChatScreen.tsx`:
- Passes `config.git.enabled` to `useMcp`
- Added `git: { enabled: true }` to the inline DEFAULT_CONFIG fallback

Updated `src/__tests__/mcp/McpManager.test.ts`:
- Added `BUILTIN_GIT_ID` import
- Added `GIT_TOOL_LIST` fixture with all four tool schemas
- Updated `connectBuiltinsAndGetTools()` helper to accept `gitEnabled` option
- Added `makeManager` git test coverage
- Added connectBuiltins git server tests
- Added getAiSdkToolsAsync git inclusion/exclusion tests
- Added `mcp_git_status`/`mcp_git_diff` — read-only forwarding test suite (5 tests)
- Added `mcp_git_stage` approval gate test suite (4 tests)
- Added `mcp_git_commit` approval gate test suite (4 tests)

Updated `src/__tests__/config.test.ts` and fixed `saveConfig` fixture objects to include `git: { enabled: true }`.

### Verification

- `npx tsc --noEmit`: 0 new errors (3 pre-existing in ArtifactPanel.tsx)
- `npx vitest run`: 661 passed / 0 failed (25 test files)
- The CommandPalette 1-failure seen in an earlier run was a pre-existing flaky timing issue — confirmed by isolated run and subsequent full-suite run both showing 0 failures.

## [2026-04-12T14:36:00Z] Phase 8: QA — full v1.0 test coverage — @qa-engineer

Audited all 6 v1.0 feature modules against their existing tests, identified gaps, wrote targeted tests.

**New test file:**
- `lib/mcp/servers/__tests__/git.test.ts` (24 tests): all 4 git tools via McpServer.prototype spy pattern. Covers status/diff/stage/commit — success paths, error returns (isError:true), argument forwarding (--staged, --, -C), fallback values.

**Extended test files:**
- `components/artifacts/__tests__/ArtifactPanel.test.tsx` (+16 tests → 21 total): diff mode toggle, accept/reject single hunk, accept/reject all hunks, onApply callback fires with correct code, onApply not called when omitted, keyboard Escape handling.
- `__tests__/selfUpdate.test.ts` (+7 tests → 19 total): performUpdate() with npm/pnpm/yarn detection via npm_config_user_agent, execFile error propagation, updateCommand output per PM.
- `lib/rag/__tests__/embedder.test.ts` (+13 tests → 27 total): embedBatch() normal/failure/empty/sequential, embed() with empty data[], json parse throw, missing embedding field, empty embedding[].
- `lib/rag/__tests__/indexer.test.ts` (+6 tests → 22 total): readFileSync throw after binary check, embedder success stores Buffer, embedder null stores null, deleteFile(), getChunksForFile(), getAllEmbeddedChunks() filters nulls.
- `lib/rag/__tests__/watcher.test.ts` (+5 tests → 12 total): onIndexed not called when all files skipped, onIndexed called only with indexed paths, indexFile throw swallowed, deleteFile throw swallowed, stop() closes chokidar.
- `lib/plugins/__tests__/registry.test.ts` (+5 tests → 40 total): Zod validation failure throws/no-write, get() with malformed JSON, get() with invalid schema.

**Final count:** 943 tests, 35 test files, all passing. TypeScript: 0 errors in test files (3 pre-existing errors in ArtifactPanel.tsx production code noted).
