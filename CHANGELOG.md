# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Uplnk uses [Semantic Versioning](https://semver.org/).

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
