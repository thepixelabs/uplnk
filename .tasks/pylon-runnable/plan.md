---
epic: pylon-runnable
phases:
  - id: 1
    title: "Generate DB migrations and wire runMigrations into app startup"
    persona: data-engineer
    status: DONE
  - id: 2
    title: "Implement config system (src/lib/config.ts) with Zod + defaults"
    persona: staff-engineer
    status: DONE
  - id: 3
    title: "Implement useConversation hook — create/load/persist messages in SQLite"
    persona: data-engineer
    status: DONE
  - id: 4
    title: "Implement useModelSelector hook — fetch live models from Ollama /api/tags"
    persona: nexus
    status: DONE
  - id: 5
    title: "Wire config into ChatScreen provider, replace hardcoded localhost"
    persona: nexus
    status: DONE
  - id: 6
    title: "Wire useConversation into ChatScreen; replace in-memory state with DB"
    persona: staff-engineer
    status: DONE
  - id: 7
    title: "Wire live models from useModelSelector into ModelSelectorScreen"
    persona: vesper
    status: DONE
---

## Context & Objective

Get Pylon from scaffold to runnable state: `pnpm dev` launches the Ink TUI and a
user can type a message and receive a streaming response from Ollama. All messages
are persisted to SQLite (~/.pylon/db.sqlite).

### Critical path

Phase 1 (data-engineer) must complete first — migrations must exist before any DB
code can run. Phases 2, 3, 4 can run in parallel after phase 1. Phase 5 depends on
phase 4 (config exists). Phase 6 depends on phases 2 and 3. Phase 7 depends on
phase 4.

### Key invariants
- DB file: ~/.pylon/db.sqlite
- Config file: ~/.pylon/config.json
- Ollama default base URL: http://localhost:11434/v1 (OpenAI-compatible endpoint)
- Ollama model list: http://localhost:11434/api/tags
- App dev command: pnpm --filter pylon-dev dev (runs tsx watch on bin/pylon.ts)
- No MCP work in this epic — that is deferred to pylon-mcp epic
