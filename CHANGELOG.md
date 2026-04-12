# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Uplnk uses [Semantic Versioning](https://semver.org/).

---

## [0.2.0] - Unreleased

This release closes every item that was still outstanding from the v0.1, v0.5, v1.0, and v0.2 roadmap checklists AND the four v0.3 items that were initially deferred but pulled back into v0.2 scope: the SecretsBackend abstraction with optional OS keychain, native Anthropic chat dispatch, MCP audit log rotation, and bulk provider registration from `config.json`. The previous "v1.0" commit was a feature-milestone label, not a released semver — the actual on-disk version had never been bumped past 0.1.0 and several promised items were missing or half-wired. 0.2.0 is the first honest release: everything scoped is actually implemented, tested, and typechecks clean.

### Added (secrets, Anthropic, audit rotation, bulk seed)

**SecretsBackend — API keys no longer plaintext in SQLite**
- New `packages/app/src/lib/secrets.ts`. Abstracts the `provider_configs.api_key` column behind a `SecretsBackend` interface with three concrete implementations tried in order at startup:
  1. `KeyringBackend` — delegates to the OS keychain via a dynamic `@napi-rs/keyring` import. NOT declared as a hard dependency — users who want real keychain storage opt in by installing the package themselves (`pnpm add @napi-rs/keyring`). Keeps install friction to zero for everyone else.
  2. `EncryptedFileBackend` — AES-256-GCM with a per-user 256-bit random key at `~/.uplnk/.secret-key` (chmod 600), ciphertext at `~/.uplnk/secrets.enc` (chmod 600). Authenticated encryption detects tampering. No native deps — works everywhere including air-gapped environments.
  3. `PlaintextBackend` — last-resort in-memory fallback when encrypted file init fails. Prints a prominent stderr warning on construction so the user knows their keys are not encrypted.
- Ref format is `@secret:<16 random hex bytes>` written into the `api_key` column. `resolveSecret(value)` transparently handles both refs and legacy plaintext rows. `migratePlaintext(value)` routes new writes through the backend.
- All five read sites updated to resolve through `resolveSecret`: `ChatScreen.providerRef`, `ProviderSelectorScreen.rowToConfig`, `ProviderSelectorScreen.onSelect`, `ModelSelectorScreen.readDefaultProviderConfig`, and the chat factory path.
- All three write sites route through `migratePlaintext`: `AddProviderScreen.save`, `seedConfigProviders` (team-wide config.json bulk seed), and any future caller. The `seedDefaultProvider` "ollama" placeholder stays plaintext by design — it's a literal dummy value, not a secret.
- Security fixes from the gate review:
  - TOCTOU race on `.secret-key` creation — key file and store now written with `{mode: 0o600}` in a single syscall, closing the read-window that existed between `writeFileSync` and a follow-up `chmodSync`.
  - Corrupted-store recovery now prints a loud multi-line stderr warning listing the backup path and the fact that all keys must be re-entered.
  - Crash log moved from `/tmp/uplnk-crash.log` → `~/.uplnk/crash.log` with mode `0o600`. The `/tmp` path was vulnerable to symlink races and information disclosure on multi-user systems.

**Native Anthropic chat dispatch**
- New `packages/app/src/lib/languageModelFactory.ts`. `createLanguageModel({providerType, baseURL, apiKey, modelId})` returns a `LanguageModelV1` by dispatching on `providerType`: `'anthropic'` → `@ai-sdk/anthropic`'s `createAnthropic` (native Messages API with `x-api-key`); everything else → `@ai-sdk/openai-compatible`. Both return a `LanguageModelV1` so `useStream` and the model router are completely unchanged.
- Added `@ai-sdk/anthropic` as a hard dependency. Base URL normalisation strips trailing `/v1` before re-appending so `api.anthropic.com`, `api.anthropic.com/v1`, and trailing-slash variants all work.

**MCP audit log rotation**
- `McpManager.rotateAuditLogIfNeeded()` runs synchronously before every `logToolCall` append. Rotates at 10 MB → `mcp-audit.log.1` (single-generation backup, clobbering any previous `.1`). Marcus's air-gapped cluster no longer risks unbounded audit log growth on a small `/home` partition.
- Rotation is best-effort under concurrent `uplnk` processes sharing the same log file — one rename window can drop a generation of backups, but the audit append itself never throws. Documented in the method comment.

**Bulk provider registration from `config.json`**
- New `config.providers` Zod array. Each entry: `{id, name, providerType, baseUrl, authMode, apiKey?, apiKeySecretRef?, defaultModel?, isDefault}`. Ids must be unique.
- `seedConfigProviders()` runs inside `getOrCreateConfig()` after `seedDefaultProvider()`. Every declared provider is upserted into SQLite. If any entry opts in as default, it's promoted via `setDefaultProvider()` in a single transaction.
- Plaintext `apiKey` values in `config.json` are routed through `migratePlaintext` so the DB column only ever stores a ref. `apiKeySecretRef` values pass through unchanged when already-formed refs.
- Known gap (documented, not fixed): `config.json` itself is still plaintext on disk. Team dotfile repositories should use `apiKeySecretRef` for secret providers and out-of-band provisioning; `apiKey` is intended for local / non-secret providers (e.g. Ollama).

### Known quirks

- **Lazy legacy migration**: rows with plaintext `api_key` from pre-0.2 builds stay plaintext until the user re-enters the key via `/add-provider`. `resolveSecret` passes them through unchanged. A `uplnk doctor --migrate-secrets` subcommand to proactively migrate is on the v0.3 list.
- **No "list refs" API**: orphaned refs (from a deleted provider whose secret was never cleaned up) accumulate in `secrets.enc` over time. Low severity — the file is bounded by the number of providers ever added. A `uplnk doctor --prune-secrets` is on the v0.3 list.



### Added

**Multi-provider model discovery and the remote-server workflow**
- New `uplnk-providers` workspace package. A `ModelProvider` interface with concrete adapters for Ollama (`/api/tags`), Anthropic (`/v1/models` with `x-api-key`), and a shared OpenAI-compatible adapter covering LM Studio, vLLM, LocalAI, llama.cpp server, OpenAI, and custom endpoints (all via `/v1/models`). Error taxonomy (`UNREACHABLE`, `AUTH_FAILED`, `NOT_SUPPORTED`, `RATE_LIMITED`, `BAD_RESPONSE`, `SERVER_ERROR`, `TIMEOUT`) with per-code user messages. Five-second discovery timeout with a single retry on UNREACHABLE / 5xx.
- New `uplnk-catalog` workspace package. A vendored snapshot of ~35 widely-used models across Ollama, OpenAI, and Anthropic with context windows, pricing, and capability flags. Users can drop a custom `~/.uplnk/catalog.json` to override or extend the built-in snapshot.
- `AddProviderScreen` — 5-step TUI wizard (type → name → URL → auth → test+save) with mandatory connection test, spinner after a 200 ms threshold, masked API key input, optimistic save on success.
- `ProviderSelectorScreen` extended with footer actions: `a` add, `t` test connection, `D` promote to default, `d` delete with inline `y/n` confirm. Last-test status surfaces per row.
- `ModelSelectorScreen` rewritten as a two-section browser — "Installed on server" (live-discovered, enriched with catalog metadata) and "Known — not installed" (catalog-only for the active provider kind). Right-hand detail panel shows context window, pricing, size, capabilities. Keyboard: `j/k` navigate, `/` search, `f` cycle filter, `r` refresh, `g/G` top/bottom, Enter to load. Colorblind-safe text badges alongside color.
- Schema: `provider_configs` gained `auth_mode` (`none` | `api-key` | `bearer`), `last_tested_at`, `last_test_status`, `last_test_detail`. The `provider_type` check constraint now accepts `openai-compatible`, `openai`, and `anthropic`. Migration `0003_provider_auth.sql`.

**Conversation list and search (closes v0.1 promise and v0.2 checklist item)**
- `ConversationListScreen` is now functional — was a stub in every prior build. Lists the 50 most recently updated conversations (soft-deletes excluded), with relative-time formatting and model id per row.
- Type-to-search over conversation titles AND message content via the new `searchConversations(db, query, limit?)` query. LIKE-based, wildcards escaped, naive ranking by `updatedAt DESC`. Empty-query path delegates to `listConversations`.
- Esc clears an active query before it goes back to chat, so the user can re-search without navigating away.
- Enter resumes the selected conversation; `App` remounts `ChatScreen` via `key` so streaming state, tool-call counter, and artifact panel reset cleanly.
- Auto-title derivation: on the first user message, the conversation title is set to the first line of that message (clamped to 60 chars). Prevents the list from filling with "New conversation" rows. Skipped for slash commands.

**Branching via `/fork` (closes v0.5 promise)**
- `/fork` slash command and palette entry. `ChatScreen.handleFork` calls the existing `forkConversation(db, sourceId, lastMessageId)` query (which was already implemented but never wired to UI), fires a new `onForkedTo` prop so `App` remounts into the forked conversation. Guarded against forking while streaming or when there are no messages. Uses the existing `branched_from_*` columns from migration 0001.

**Custom MCP server configuration in `config.json` (closes v0.2 checklist item)**
- `config.mcp.servers` field — Zod discriminated union on `type`, with `stdio` servers requiring a `command` and `http` servers requiring a `url`. Ids starting with `__uplnk_builtin_` are rejected at parse time to prevent shadowing built-in servers. Duplicate ids within the array are rejected.
- `useMcp` merges three server sources: `config.json` (team-wide) < plugins (community) < `.mcp.json` (project-local), with `.mcp.json` winning on id collision so a project's explicit config always overrides globally installed plugins. Warnings for each collision surface via `console.warn` with the losing source labelled.

**Plugin loader wired (closes half-done v1.0 phase 6)**
- `loadPluginConfigs()` in `plugins/loader.ts` is now actually called from `useMcp`. Before this release, the plugin CLI installed plugins to `~/.uplnk/plugins/` but `useMcp` never read them back, so installed plugins never loaded into the MCP tool set. Now they do.

**`@file` mention in `ChatInput` (closes v0.2 checklist item)**
- New `packages/app/src/lib/fileMention.ts` — synchronous project walker with a module-level cache keyed on `rootDir`, respecting the same `SKIP_DIRS` / `SKIP_EXTENSIONS` lists as `projectContext`. `MAX_ENTRIES=1000`, `MAX_DEPTH=8`. `filterMentionCandidates` does case-insensitive substring match, ranked by first-match position with alphabetical tie-break.
- `ChatInput` detects `@` as a trigger at start-of-buffer or after whitespace, opens an inline popover showing up to 8 filtered candidates. Typing past the `@` narrows the list. Enter inserts `@<path> ` and closes the popover. Esc closes without inserting and strips the abandoned `@query` substring so a later `@` re-triggers cleanly. Space commits the `@query` as literal text (so `email@example.com` still works). A single `useInput` hook dispatches between normal and mention modes to avoid focus-ownership conflicts.

**Multi-line input (closes v0.2 checklist item)**
- `Shift+Enter` (and `Alt/Meta+Enter` as a fallback for terminals that strip the shift modifier) inserts a literal newline. Plain `Enter` still submits. The display code already handled multi-line rendering — this release fixes the input path that previously always submitted.

**`uplnk doctor migrate-secrets` and `uplnk doctor prune-secrets` (closes v0.2 secrets story end-to-end)**
- New sub-subcommand: `uplnk doctor migrate-secrets`. Iterates `provider_configs`, finds rows where `api_key` is non-null, non-empty, not already a `@secret:` ref, and not the literal `'ollama'` placeholder, routes each through `migratePlaintext()` and writes the resulting ref back via the new `setProviderApiKey(db, id, apiKey)` query. **Two-phase compensating action**: if `setProviderApiKey` fails after `migratePlaintext` has stored the secret, the just-written ref is rolled back via `backend.deleteSecret(ref)` so partial failures don't leak orphans. Idempotent — repeated runs against an already-migrated DB are no-ops.
- New sub-subcommand: `uplnk doctor prune-secrets`. Calls the new `SecretsBackend.listRefs()` method to enumerate every ref in the store, builds the live-ref set from `listProviders(db)`, deletes the orphans via the new `SecretsBackend.deleteSecretsBulk(refs)` method (single `persist()` call regardless of orphan count). `KeyringBackend.listRefs()` returns `null` because the OS keychain has no portable list operation; pruning is a no-op for keyring storage with a clear user-facing message.
- `bin/uplnk.ts` adds an unknown-action guard so `uplnk doctor purge-secrets` (typo) exits with `unknown doctor action` instead of silently running the 4-check preflight.

**Provider EDIT inside the TUI (closes v0.2 provider management story)**
- `AddProviderScreen` now accepts an `editing` prop. When set, the screen runs in EDIT mode: title becomes "Edit Provider", initial step jumps to URL (the most common edit), the draft is prefilled with the row's current values, and the save path upserts on the existing id rather than minting a new one. `defaultModel` and `isDefault` are preserved across edits.
- `ProviderSelectorScreen` adds an `e` keybind that resolves the cleartext via `resolveSecret(p.apiKey)` and routes to a new `'edit-provider'` screen at the `App` level.
- **Key reuse logic** (security gate H1): the save path passes `editing.rawApiKey` (the un-resolved column value) alongside the cleartext. When `draft.apiKey === editing.apiKey` AND `editing.rawApiKey` is a `@secret:` ref, the existing ref is reused — preventing a fresh ref on every edit and the orphan accumulation that would follow. When the key DOES change, the previous ref is explicitly deleted from the backend after the upsert so prune-secrets isn't the only path that reclaims it.

**RAG auto-init (closes v1.0 phase 3 — was opt-in only)**
- New `maybeAutoEnableRag(config)` in `lib/config.ts`. Probes `OLLAMA_BASE_URL` (or `http://localhost:11434` default) at startup, looks for any model whose name contains `nomic-embed-text`, and if found mutates the in-memory config to enable RAG with the discovered model. Skipped when `config.rag.autoDetect=false` (new field, default `true`) or when RAG is already explicitly enabled.
- **SSRF guard** (security gate M2): `validateOllamaProbeUrl` rejects non-localhost hosts unless `UPLNK_TRUST_OLLAMA_URL=1` is set. This blocks the userinfo-trick (`http://localhost@evil.com`), permits IPv6 loopback (`[::1]`), and rejects `0.0.0.0`. Without the opt-in, only `localhost`, `127.0.0.1`, and `::1` pass.
- **Bug fix**: the `/v1` strip used to live in the default-parameter expression, so explicit callers passing `http://host:11434/v1` got `/v1/api/tags`. Strip moved into the function body.
- 1.5 s timeout — startup is never delayed past the time it takes to fail.

**Other fixes and polish**
- `useMcp.ratelimit.test.ts` had a load-bearing syntax error (unterminated string on line 155) that silently prevented the file from compiling in some runs — fixed.
- `NPM_REGISTRY_TIMEOUT_MS` dropped from 3000 to 2000 in `selfUpdate.ts` to shorten first-run startup in air-gapped environments.
- `MCP audit log rotation` at 10 MB (one backup generation) added to `McpManager`, race-tolerant under concurrent processes.
- IPv4-first global undici dispatcher in `bin/uplnk.ts` so LAN aliases that resolve to both link-local IPv6 and IPv4 prefer IPv4 and don't hang on `fe80::` connection attempts.
- IPv6 link-local warning in `uplnk-providers/src/base.ts` for hostnames that resolve only to `fe80::*` addresses — the connection would otherwise time out silently.
- All Ink stdin keyboard tests use a double-`setImmediate` `tick()` helper to deflake the keypress race when the event loop is busy. `useStream.test.ts` keeps a single-tick helper because its barrier-based mock relies on advancing exactly one microtask.
- `useStream.test.ts:194` state-machine drift fixed: the test asserted `'streaming'` after one tick with no chunks, but the state machine now has a `'waiting'` step between `'connecting'` and `'streaming'`. Test now accepts both states and asserts the contract is "not idle / not connecting".
- Ctrl+C abort-mid-stream was already correctly implemented at `ChatScreen.tsx`; an earlier audit misread the code and flagged it as missing. No change required — documenting here to close the audit loop.

### Tests

- **1084 tests** across 47 files (up from 904 / 34 in v0.1). Stable across three consecutive full-suite runs.
- New test files: `searchConversations.test.ts`, `fileMention.test.ts`, `useMcp.merge.test.ts`, `ConversationListScreen.test.tsx`, `ChatInput.mention.test.tsx`, `ChatScreen.fork.test.tsx`. 89 new tests total covering the v0.2 additions.

### Nothing deferred

Per CEO directive issued during this release cycle: every item from the v0.1, v0.5, v1.0, and v0.2 roadmap checklists ships in v0.2.0. No "Coming in v0.3+" parking lot. The next release will plan its own scope from scratch rather than inheriting unfinished work.

---

## [0.1.0] - Unreleased

Initial release. Establishes the full Ink TUI foundation, Ollama streaming, conversation persistence, MCP file tools, and the `uplnk doctor` preflight command.

### Added

**Terminal UI**
- Ink (React for CLI) application with a three-screen architecture: `chat`, `model-selector`, and `conversations`
- `Header` component — shows the Uplnk wordmark, active model name, and conversation title
- `StatusBar` — displays stream status (`idle`, `connecting`, `streaming`, `done`, `error`) and message count
- `ChatInput` — single/multi-line input with a blinking cursor, up to 5 lines displayed; greyed out with a spinner hint during streaming
- `MessageList` — renders conversation history using Ink `<Static>` to avoid full re-renders on each streaming tick
- `StreamingMessage` — live token display during an active Ollama stream
- `ErrorBanner` — dismissable full-width error overlay surfaced from any screen
- `ArtifactPanel` — 50/50 horizontal split view for code artifacts promoted from assistant messages
- `ApprovalDialog` — blocking consent overlay for MCP `command-exec` invocations
- Dark theme (default) and light theme; switchable via `--theme` flag or `UPLNK_THEME` environment variable
- Colour system in `lib/colors.ts` — Tailwind-sourced palette with separate dark/light variants; respects `NO_COLOR`
- Uplnk wordmark rendered as a structural column cross-section (`▐█▌ UPLNK`) using blue accent colours

**Streaming**
- `useStream` hook wrapping Vercel AI SDK `streamText()` called in-process (no HTTP bridge)
- Token buffer with a 33 ms flush interval (~30 fps) — decouples React re-render rate from Ollama token rate
- `Ctrl+C` aborts an active stream without exiting the application; `AbortController` is closed and the event loop drains cleanly on exit
- Stream status state machine: `idle` → `connecting` → `streaming` → `done` | `error`

**Conversation persistence**
- SQLite database at `~/.uplnk/db.sqlite` via `better-sqlite3` and Drizzle ORM
- Schema: `conversations`, `messages`, `artifacts`, `provider_configs` tables
- `useConversation` hook — loads history on mount, appends user and assistant messages on completion
- `--conversation <id>` / `-c` flag to resume a previous session
- `ConversationListScreen` — browse saved conversations (`Ctrl+L` to open, `Esc` to close)

**Model selector**
- `/model` typed in the chat input opens the model selector screen
- `ModelSelectorScreen` — fetches the model list from `http://localhost:11434/api/tags`, renders an arrow-key-navigable list
- `useModelSelector` hook — handles the Ollama API call, loading state, and error display
- Selected model is reflected immediately in the `Header` and used for all subsequent messages

**Input experience**
- `Enter` to send; message is validated (non-empty) before dispatch
- Up/down arrow keys cycle through sent messages within the current session; draft is preserved when entering history-browse mode and restored on the way back down

**MCP tools**
- `McpManager` — lifecycle management for MCP child-process connections via `@modelcontextprotocol/sdk` `StdioClientTransport`
- `mcp_file_read` tool — reads a file; enforces `mcp.allowedPaths` allowlist and a configurable `maxReadBytes` limit
- `mcp_file_list` tool — lists directory contents; respects allowlist, skips dotfiles, supports recursive listing up to a configurable depth
- `mcp_command_exec` tool — feature-flagged (`mcp.commandExecEnabled: false` by default); when enabled, requires human approval via `ApprovalDialog` per invocation; runs with a stripped environment, `shell: false`, 30 s timeout, and 512 KB output cap
- `security.ts` — path validation (resolves symlinks, checks prefix against allowlist) and command validation (denylist of destructive binaries)
- `useMcp` hook — integrates `McpManager` with the chat screen; exposes tools to `streamText()` and pending-approval state to the UI

**CLI**
- `npx uplnk-dev` — zero global install entry point
- `uplnk chat` (default), `uplnk doctor`, `uplnk config`, `uplnk conversations` subcommands
- `--model` / `-m`, `--provider` / `-p`, `--conversation` / `-c`, `--theme` / `-t`, `--help` / `-h`, `--version` / `-v` flags
- Crash log written synchronously to `/tmp/uplnk-crash.log` on `uncaughtException` and `unhandledRejection`
- `SIGTERM` and `SIGHUP` handlers for clean shutdown

**`uplnk doctor`**
- Node.js version check (requires >= 20)
- Config directory writability check (`~/.uplnk`)
- SQLite connectivity check (`SELECT 1` against the live database)
- Ollama reachability check (`/api/tags` with a 3-second timeout)
- Colour-coded pass/fail output; exits with code 1 if any check fails

**Configuration**
- `~/.uplnk/config.json` created on first run with defaults (version 1, dark theme, MCP allowedPaths empty, commandExecEnabled false)
- `lib/config.ts` — Zod-validated schema with `getOrCreateConfig()`, `loadConfig()`, `saveConfig()`
- Provider configuration seeded to SQLite on first run (`ollama-local` pointing to `http://localhost:11434/v1`)
- `uplnk config` opens the config file in `$EDITOR`

**Packages**
- `uplnk-dev` (`packages/app`) — Ink TUI application, published to npm
- `uplnk-db` (`packages/db`) — Drizzle schema, migrations, and query helpers; internal workspace dependency
- `uplnk-shared` (`packages/shared`) — `UplnkError` type and error codes; shared by app and db

**Tooling**
- pnpm workspaces monorepo
- TypeScript strict mode across all packages
- Vitest for unit tests; `ink-testing-library` for component tests
- ESLint with `@typescript-eslint` ruleset
- `tsup` for production builds
- `tsx` for zero-build dev execution
- Husky + lint-staged for pre-commit checks
