```
▐█▌ uplnk
```
**Your code stays on your machine. Your costs stay in check.**

*For DevOps and staff engineers who run AI-assisted workflows in the terminal — local-first, multi-provider, with intelligent cost routing between local and frontier models.*

[![npm](https://img.shields.io/npm/v/pylon-dev?color=60A5FA&label=npm)](https://www.npmjs.com/package/pylon-dev)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green)](https://nodejs.org)

> The npm package is transitioning from `pylon-dev` to `uplnk`. Existing `npx pylon-dev` invocations continue to work during the transition.

---

```
┌─────────────────────────────────────────────────────────────────┐
│ ▐█▌ uplnk          New conversation               llama3.2      │
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

## Why uplnk

- **Privacy-first by architecture.** Your code never leaves your machine when you run against a local provider. No cloud routing by default. uplnk talks directly to Ollama (or any OpenAI-compatible server) running on localhost.
- **Studio-grade UX, local models.** Streaming text with syntax-highlighted code blocks, an artifact side-panel, conversation persistence, and a keyboard-driven model selector — the experience Claude Code users expect, pointed at your own inference server.
- **Zero lock-in.** SQLite database at `~/.uplnk/db.sqlite`. Plain JSON config at `~/.uplnk/config.json`. Apache 2.0 license. Fork it, own it.
- **Open-source forever.** The full terminal UI, streaming, MCP tools, conversation history — all free, no feature gates.
- **Cost-intelligent by design.** Relay Mode routes cheap triage and analysis work to local models and reserves frontier API spend for final execution. The Scout/Anchor split cuts per-session API cost 60–80% on eligible tasks — without changing the quality of the answer you get back.

---

## Quick start

**Step 1 — Start Ollama**

```bash
ollama serve           # if not already running as a service
ollama pull llama3.2   # or any model you prefer
```

**Step 2 — Run uplnk**

```bash
npx pylon-dev
```

That's it. No global install required. On first run uplnk creates `~/.uplnk/config.json` and `~/.uplnk/db.sqlite` automatically.

**Step 3 — Verify your setup (optional)**

```bash
npx pylon-dev doctor
```

---

## Features

- Terminal chat UI (Ink/React) with real-time streaming
- Syntax-highlighted code blocks in responses
- Artifact side-panel — expandable code blocks in a 50/50 split view
- Conversation persistence and history list, with full-text search
- Multi-provider support — Ollama, OpenAI-compatible, LM Studio, vLLM, LocalAI, llama.cpp, OpenAI, Anthropic, custom endpoints
- Relay Mode — two-phase cost routing between a local Scout model and a frontier Anchor model
- Network Scanner — auto-discover inference servers on localhost and your /24 subnet
- MCP tools — file read/list with path allowlist, optional command-exec behind explicit consent
- RAG over your project directory when a local embedder is available
- Plugin loader for community MCP servers
- Encrypted secrets backend — AES-256-GCM by default, optional OS keychain
- `uplnk doctor` — preflight checks for Node, config, database, and provider reachability

---

## Relay Mode

```
┌─────────────────────────────────────────────────────────────────┐
│ ▐█▌ uplnk          relay: code-review               /relay      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Scout  ── qwen2.5:7b ──────────────────────────────────────    │
│  Analyzing diff for review scope…                                │
│                                                                  │
│  Files changed: 4  |  +312 / -89  |  primary concern:           │
│  auth/session.ts modifies token expiry logic without             │
│  updating the corresponding refresh path. Potential              │
│  session fixation window on concurrent requests. Flag            │
│  for deep review. Remaining files are cosmetic. ▌                │
│                                                                  │
│  ─────────────── Scout complete · Anchor up ──────────────────  │
│                                                                  │
│  Anchor  ── claude-sonnet-4 ────────────────────────────────    │
│  Looking at auth/session.ts — the race condition is in           │
│  the 200 ms window between `validateToken()` and                 │
│  `rotateSession()`. An attacker who replays the old              │
│  token inside that window gets a valid session. Fix:  ▌          │
│                                                                  │
│  [streaming…]  Scout 312 tok  ·  Anchor 89 tok                   │
├─────────────────────────────────────────────────────────────────┤
│ ❯ │  /relay to start  ·  /relays to list  ·  Esc to cancel      │
╰─────────────────────────────────────────────────────────────────╯
```

- **Two-phase cost routing.** A cheap local Scout model (e.g. `qwen2.5:7b` on Ollama) reads the full context and produces a focused brief. A frontier Anchor model (e.g. Claude Sonnet) executes only on that brief — 60–80% less token spend on eligible tasks.
- **Named relay templates.** Define a relay once as a JSON config, save it by name, reuse it across sessions. The Scout and Anchor models, their system prompts, and handoff behavior are all versioned together.
- **Visible handoff.** The `─── Scout complete · Anchor up ───` separator marks the phase boundary in the stream. You see Scout's reasoning before Anchor acts on it.

Cursor, Claude Code, and Continue.dev send every request to the most expensive model available. Relay Mode lets you decide which part of your work actually needs that.

### Creating and running a relay

Type `/relay` in the chat input, or open the command palette (`Ctrl+K`) and choose "Run a Relay". From the Relay Picker, press `n` to create a new relay.

The editor walks you through four steps: name → Scout config → Anchor config → save.

### Relay file format

Relay files live at `~/.uplnk/relays/<id>.json`. You can write or edit them by hand.

```json
{
  "version": 1,
  "id": "pr-review",
  "name": "PR review",
  "scout": {
    "providerId": "ollama-local",
    "model": "qwen2.5:7b",
    "systemPrompt": "Analyze the task below. Think through the approach step by step. Identify the key risk or complexity. Be concise."
  },
  "anchor": {
    "providerId": "anthropic-main",
    "model": "claude-sonnet-4",
    "systemPrompt": "You are given an analysis prepared by a Scout model. Use it as your plan and execute the task completely.",
    "mcpEnabled": true
  }
}
```

| Field | Type | Description |
|---|---|---|
| `version` | `1` | Schema version. Must be `1`. |
| `id` | string | Filename stem. Unique across `~/.uplnk/relays/`. Used as the `relay_id` tag on saved conversations. |
| `name` | string | Display name shown in the Relay Picker. |
| `scout.providerId` | string | Provider ID from your uplnk config. |
| `scout.model` | string | Model for the analysis phase. A capable 7B–14B local model works well here. |
| `scout.systemPrompt` | string | System prompt injected for the Scout phase only. |
| `anchor.providerId` | string | Provider ID for the execution phase. Typically a frontier model. |
| `anchor.model` | string | Model for the execution phase. |
| `anchor.systemPrompt` | string | System prompt injected for the Anchor phase only. |
| `anchor.mcpEnabled` | boolean | Whether MCP tools are available during the Anchor phase. Default: `true`. |

---

## Network Scanner

```
┌─────────────────────────────────────────────────────────────────┐
│ ▐█▌ uplnk          Network scan                     /scan       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Scanning local network for AI inference servers…  /            │
│  192.168.1.0/24  ·  ports 11434 1234 8000 8080 3000             │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  DISCOVERED                                              │   │
│  ├──────────────────────────────────────────────────────────┤   │
│  │  > localhost:11434      Ollama          llama3.2 +4       │   │
│  │    192.168.1.42:1234    LM Studio       mistral-7b        │   │
│  │    192.168.1.50:8000    vLLM            meta-llama/…      │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  3 servers found  ·  still scanning…                             │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  Enter add selected  ·  ↑/↓ move  ·  a add all  ·  Esc cancel  │
╰─────────────────────────────────────────────────────────────────╯
```

`/scan` probes your local machine and /24 subnet for running AI inference servers and offers one-click addition to uplnk.

**Invoke it:** type `/scan` in the chat input, or open the command palette (`Ctrl+K`) and choose "Scan local network".

**Servers discovered:**

| Server type | Default port |
|---|---|
| Ollama | 11434 |
| LM Studio | 1234 |
| vLLM | 8000 |
| llama.cpp | 8080 |
| LocalAI | 8080 |
| OpenWebUI | 3000 |

Each result shows the server type, URL, and first available model. Press `Enter` on any result to add it to uplnk — no manual wizard required. Press `a` to add all discovered servers at once.

**Subnet scanning requires consent.** Before scanning beyond localhost, uplnk prompts you once for explicit permission. The scan is on-demand only — uplnk never probes the network in the background. No data leaves your machine; the scanner makes direct TCP connections on your local network only.

---

## Configuration

uplnk reads `~/.uplnk/config.json`. The file is created with defaults on first run.

```json
{
  "version": 1,
  "defaultModel": "llama3.2",
  "theme": "dark",
  "mcp": {
    "allowedPaths": [],
    "commandExecEnabled": false
  },
  "relayMode": {
    "enabled": true
  },
  "networkScanner": {
    "enabled": true
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `version` | `1` | `1` | Config schema version. Must be `1`. |
| `defaultModel` | string | `"llama3.2"` | Model passed to the provider when no `--model` flag is given. |
| `theme` | `"dark"` \| `"light"` | `"dark"` | Color theme. Override at runtime with `--theme`. |
| `mcp.allowedPaths` | string[] | `[]` | Absolute paths the LLM may read via MCP file tools. Empty array defaults to the current working directory. |
| `mcp.commandExecEnabled` | boolean | `false` | Enables the `mcp_command_exec` tool. Disabled by default — read the [MCP security notes](#mcp-security) before enabling. |
| `relayMode.enabled` | boolean | `true` | Set to `false` to disable Relay Mode and hide `/relay` from the UI. |
| `networkScanner.enabled` | boolean | `true` | Set to `false` to disable the Network Scanner and hide `/scan` from the UI. |

To edit the config in your `$EDITOR`:

```bash
uplnk config
```

### CLI flags

```
USAGE
  uplnk [command] [options]

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

CLI flags take precedence over `config.json`. The `UPLNK_THEME` environment variable is also respected. (`PYLON_THEME` is deprecated, use `UPLNK_THEME`.)

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Enter` | Send message |
| `↑` / `↓` | Cycle through input history |
| `Ctrl+K` | Open command palette |
| `Ctrl+L` | Open conversation list |
| `Ctrl+W` | Open Relay picker |
| `Ctrl+N` | Open Network scanner |
| `Ctrl+C` | Abort streaming response (press again to exit) |
| `Ctrl+A` | Dismiss artifact panel |
| `Esc` | Return to chat from any secondary screen |
| `/model` | Open model selector |
| `/relay` | Open Relay picker (run a relay) |
| `/scan` | Scan local network for inference servers |

---

## uplnk doctor

Run `uplnk doctor` (or `npx pylon-dev doctor`) to diagnose your environment before filing a bug report.

```
uplnk Doctor

  ✓  Node.js version        v22.3.0
  ✓  Config directory       /Users/you/.uplnk
  ✓  SQLite database        /Users/you/.uplnk/db.sqlite
  ✓  Ollama reachability    http://localhost:11434

All checks passed. uplnk is ready.
```

Checks performed:

| Check | Pass condition |
|---|---|
| Node.js version | >= 20 |
| Config directory | `~/.uplnk` exists and is writable |
| SQLite database | `~/.uplnk/db.sqlite` is accessible and responds to a query |
| Ollama reachability | `http://localhost:11434/api/tags` responds within 3 seconds |

If a check fails, the output shows the exact reason. Fix the issue and re-run `uplnk doctor`.

**Migration from `~/.pylon/`.** On first run after upgrading from a `pylon`-era install, `uplnk doctor` automatically migrates `~/.pylon/` to `~/.uplnk/` — config, database, relays, secrets, and plugins are moved in place. The original `~/.pylon/` directory is left untouched as a backup. Re-running `uplnk doctor` after migration is a no-op.

---

## MCP security

The MCP file-read tools (`mcp_file_read`, `mcp_file_list`) are always enabled. They respect the `mcp.allowedPaths` allowlist — the LLM can only read paths under those directories.

The `mcp_command_exec` tool is **disabled by default** and gated by two layers of enforcement:

1. `mcp.commandExecEnabled: true` must be set in `config.json`.
2. Every invocation shows an in-terminal approval dialog. The command does not run until you press `y`.

The tool executes with a stripped environment (no secrets inherited from the parent process), a 30-second timeout, shell expansion disabled (`shell: false`), and a 512 KB output limit.

Crash logs are written to `~/.uplnk/crash.log` with mode `0600`.

Do not enable `commandExecEnabled` in shared or automated environments.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
