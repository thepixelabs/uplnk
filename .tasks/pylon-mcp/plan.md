---
epic: pylon-mcp
phases:
  - id: 1
    title: "Security sandbox design + approval gate spec"
    persona: security-engineer
    status: DONE
  - id: 2
    title: "MCP client infrastructure: StdioClientTransport + McpManager"
    persona: nexus
    status: DONE
  - id: 3
    title: "MCP file-browse tool: path allowlist + read-only FS operations"
    persona: staff-engineer
    status: DONE
  - id: 4
    title: "MCP command-exec tool: Ink approval dialog + sandboxed execFile"
    persona: staff-engineer
    status: DONE
    unblocked_reason: "pylon-mcp-security Phase 8 DONE 2026-04-12 — all 6 BCs verified PASS. Sign-off at internal-doc/mcp-security-signoff-v2.md."
  - id: 5
    title: "Wire MCP tools into useStream + ChatScreen tool loop"
    persona: nexus
    status: DONE
  - id: 6
    title: "Config: mcpAllowedPaths + mcpCommandExecEnabled feature flag"
    persona: staff-engineer
    status: DONE
  - id: 7
    title: "QA: unit + integration tests for MCP layer"
    persona: qa-engineer
    status: DONE
  - id: 8
    title: "Security engineer sign-off review"
    persona: security-engineer
    status: DONE
  - id: 9
    title: "Gap 3 (stale streamedText on abort) — fix dispatched"
    persona: staff-engineer
    status: DONE
  - id: 10
    title: "Gap 1+2: Wire real MCP servers — load .mcp.json, StreamableHTTP transport, listTools() → AI SDK Tool via jsonSchema(), callMcpTool() + transport death handlers"
    persona: nexus
    status: DONE
  - id: 11
    title: "Gap 4: useMemo identity stabilisation for mcpTools in useMcp.ts"
    persona: nexus
    status: DONE
  - id: 12
    title: "Gap 5: fullStream migration + tool-running StreamStatus + StatusBar UX"
    persona: nexus
    status: DONE
  - id: 13
    title: "Gap 6: Default model llama3.2 → qwen2.5:7b for reliable tool-calling"
    persona: staff-engineer
    status: DONE
  - id: 14
    title: "Security hardening: command allowlist, per-arg validation, audit log, rate limiting, approval dialog safety (BC-1 through BC-6)"
    persona: security-engineer
    status: DONE
    depends_on_epic: pylon-mcp-security
---

## Context & Objective

Implement MCP (Model Context Protocol) integration via child_process stdio transport.
Two capabilities ship in v0.1:

1. **file-browse** — read-only filesystem access with path allowlist enforcement
2. **command-exec** — shell command execution with mandatory blocking Ink approval dialog

Security-engineer sign-off required before merging command-exec. If not signed off,
feature-flag it disabled by default and ship file-browse + the rest of v0.1 on schedule.

Reference: chatty/reports/07-nexus-protocols-v2.md, 11-security-threat-model.md
