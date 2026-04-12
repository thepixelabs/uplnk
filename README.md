```
▐█▌ PYLON
```
**Local models. Studio-grade UX.**

[![npm](https://img.shields.io/npm/v/pylon-dev?color=60A5FA&label=npm)](https://www.npmjs.com/package/pylon-dev)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green)](https://nodejs.org)

---

```
┌─────────────────────────────────────────────────────────────────┐
│ ▐█▌ PYLON          New conversation               llama3.2      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  You  ──────────────────────────────────────────────────────    │
│  Refactor this function to use async/await                       │
│                                                                  │
│  Assistant  ────────────────────────────────────────────────    │
│  Here's the refactored version:                                  │
│                                                                  │
│  ```typescript                                                   │
│  async function fetchUser(id: string): Promise<User> {          │
│    const res = await fetch(`/api/users/${id}`);                  │
│    if (!res.ok) throw new Error(`HTTP ${res.status}`);           │
│    return res.json() as Promise<User>;                           │
│  }                                                               │
│  ```                                                             │
│                                                                  │
│  The key changes: removed the Promise constructor wrapper,       │
│  replaced .then() chains with await, and let errors propagate    │
│  naturally up to the caller.                                     │
│                                                                  │
│  [streaming…]  3 messages                                        │
├─────────────────────────────────────────────────────────────────┤
│ ❯ │  type a message — Enter to send, /model to switch model     │
╰─────────────────────────────────────────────────────────────────╯
```

---

## Why Pylon

- **Privacy-first by architecture.** Your code never leaves your machine. No API keys, no cloud routing, no telemetry. Pylon talks directly to Ollama running on localhost.
- **Studio-grade UX, local models.** Streaming text with syntax-highlighted code blocks, an artifact side-panel, conversation persistence, and a keyboard-driven model selector — the experience Claude Code users expect, pointed at your own inference server.
- **Zero lock-in.** SQLite database at `~/.pylon/db.sqlite`. Plain JSON config at `~/.pylon/config.json`. Apache 2.0 license. Fork it, own it.
- **Open-source forever.** The full terminal UI, Ollama streaming, MCP file tools, conversation history — all free, no feature gates.

---

## Quick start

**Step 1 — Start Ollama**

```bash
ollama serve           # if not already running as a service
ollama pull llama3.2   # or any model you prefer
```

**Step 2 — Run Pylon**

```bash
npx pylon-dev
```

That's it. No global install required. On first run Pylon creates `~/.pylon/config.json` and `~/.pylon/db.sqlite` automatically.

**Step 3 — Verify your setup (optional)**

```bash
npx pylon-dev doctor
```

---

## Features

### Built (v0.1)

- [x] Terminal chat UI (Ink/React) with real-time Ollama streaming
- [x] Syntax-highlighted code blocks in responses
- [x] Artifact side-panel — expandable code blocks in a 50/50 split view
- [x] Conversation persistence — SQLite via Drizzle ORM
- [x] Conversation history list (`Ctrl+L`)
- [x] Resume a previous conversation (`--conversation <id>`)
- [x] `/model` command palette — browse and switch Ollama models without leaving the chat
- [x] Input history — `↑`/`↓` to cycle through messages sent this session
- [x] MCP file tools — `mcp_file_read` and `mcp_file_list` (path allowlist enforced)
- [x] MCP command-exec tool — feature-flagged off by default; requires explicit config opt-in and human approval dialog per invocation
- [x] Dark theme (default) and light theme (`--theme light` or `PYLON_THEME=light`)
- [x] `pylon doctor` — pre-flight checks for Node version, config dir, SQLite, and Ollama reachability
- [x] Crash log at `/tmp/pylon-crash.log` for debugging
- [x] `Ctrl+C` aborts a streaming response without exiting

### Coming in v0.2+

- [ ] Multi-provider support (vLLM, LM Studio, LocalAI, llama.cpp)
- [ ] Conversation search
- [ ] System prompt customization
- [ ] Custom MCP server configuration
- [ ] `@file` mention in chat input
- [ ] Diff view before applying file edits

---

## Configuration

Pylon reads `~/.pylon/config.json`. The file is created with defaults on first run.

```json
{
  "version": 1,
  "defaultModel": "llama3.2",
  "theme": "dark",
  "mcp": {
    "allowedPaths": [],
    "commandExecEnabled": false
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `version` | `1` | `1` | Config schema version. Must be `1`. |
| `defaultModel` | string | `"llama3.2"` | Model passed to Ollama when no `--model` flag is given. |
| `theme` | `"dark"` \| `"light"` | `"dark"` | Color theme. Override at runtime with `--theme`. |
| `mcp.allowedPaths` | string[] | `[]` | Absolute paths the LLM may read via MCP file tools. Empty array defaults to the current working directory. |
| `mcp.commandExecEnabled` | boolean | `false` | Enables the `mcp_command_exec` tool. Disabled by default — read the [MCP security notes](#mcp-security) before enabling. |

To edit the config in your `$EDITOR`:

```bash
pylon config
```

### CLI flags

```
USAGE
  pylon [command] [options]

COMMANDS
  chat            Start or resume a conversation (default)
  doctor          Run preflight checks
  config          Open config in $EDITOR
  conversations   List saved conversations

OPTIONS
  -m, --model         Model name (e.g. llama3.2, qwen2.5-coder:7b)
  -p, --provider      Provider ID from config
  -c, --conversation  Resume conversation by ID
  -t, --theme         Color theme: dark (default) or light
  -h, --help          Show this help
  -v, --version       Show version
```

CLI flags take precedence over `config.json`. `PYLON_THEME` environment variable is also respected.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Enter` | Send message |
| `↑` / `↓` | Cycle through input history |
| `/model` | Open model selector |
| `Ctrl+C` | Abort streaming response (press again to exit) |
| `Ctrl+L` | Open conversation list |
| `Ctrl+A` | Dismiss artifact panel |
| `Esc` | Return to chat from any secondary screen |

---

## pylon doctor

Run `pylon doctor` (or `npx pylon-dev doctor`) to diagnose your environment before filing a bug report.

```
Pylon Doctor

  ✓  Node.js version        v22.3.0
  ✓  Config directory       /Users/you/.pylon
  ✓  SQLite database        /Users/you/.pylon/db.sqlite
  ✓  Ollama reachability    http://localhost:11434

All checks passed. Pylon is ready.
```

Checks performed:

| Check | Pass condition |
|---|---|
| Node.js version | >= 20 |
| Config directory | `~/.pylon` exists and is writable |
| SQLite database | `~/.pylon/db.sqlite` is accessible and responds to a query |
| Ollama reachability | `http://localhost:11434/api/tags` responds within 3 seconds |

If a check fails, the output shows the exact reason. Fix the issue and re-run `pylon doctor`.

---

## MCP security

The MCP file-read tools (`mcp_file_read`, `mcp_file_list`) are always enabled. They respect the `mcp.allowedPaths` allowlist — the LLM can only read paths under those directories.

The `mcp_command_exec` tool is **disabled by default** and gated by two layers of enforcement:

1. `mcp.commandExecEnabled: true` must be set in `config.json`.
2. Every invocation shows an in-terminal approval dialog. The command does not run until you press `y`.

The tool executes with a stripped environment (no secrets inherited from the parent process), a 30-second timeout, shell expansion disabled (`shell: false`), and a 512 KB output limit.

Do not enable `commandExecEnabled` in shared or automated environments.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
