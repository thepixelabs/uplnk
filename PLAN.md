# uplnk — Implementation Plan

Generated: 2026-04-13  
Status: Active

---

## Panel consensus

Six-reviewer cross-functional audit (architect, CTO, devops, staff-engineer, product, brand). Target users: DevOps engineers and staff engineers. Current state: solid 0.3 alpha, not yet a daily driver.

---

## Track 0 — Hotfixes (ship immediately, no dependencies)

These are correctness failures in already-advertised features. Treat as a point release before v0.4 sprint work begins.

| ID | Fix | Files |
|----|-----|-------|
| H1 | Wire RelayPickerScreen / RelayRunScreen / RelayEditorScreen / NetworkScanScreen into `index.tsx` App router + register `/relay` and `/scan` slash commands | `packages/app/src/index.tsx`, `packages/app/src/components/chat/ChatInput.tsx` |
| H2 | Remove duplicate assistant row — streaming path pre-inserts empty row AND `addMessage` fires at end; expose `appendToState`-only path from `useConversation` | `packages/app/src/components/chat/ChatScreen.tsx:195–205`, `packages/app/src/hooks/useConversation.ts` |
| H3 | Fix RAG tautological WHERE clause — `getAllEmbeddedChunks()` uses `eq(ragChunks.filePath, ragChunks.filePath)` which loads entire table into memory | `packages/app/src/lib/rag/indexer.ts` |

---

## Track 1 — Sprint 1: Trust the Context (Weeks 1–2)

> Goal: an engineer runs a 30-message incident session without silent context failures, can scroll back to message 1, and accepts a suggested fix that writes to disk.

No dependencies between items — all can run in parallel.

| ID | Feature | Files (approximate) | Size |
|----|---------|---------------------|------|
| S1-A | Token counter + context gauge in StatusBar — count tokens per turn, show `N / MAX` gauge, warn at 80% | new `packages/app/src/lib/tokenCounter.ts`, `packages/app/src/components/StatusBar.tsx`, `packages/app/src/hooks/useStream.ts` | L |
| S1-B | `/compact` command — summarize early turns via active provider, truncate from DB, free context | `packages/app/src/components/chat/ChatScreen.tsx`, `packages/app/src/hooks/useConversation.ts`, `packages/app/src/lib/` | M |
| S1-C | Message scrollback — viewport scroll with PgUp/PgDn and ↑/↓ in message list inside alt-screen | `packages/app/src/components/chat/MessageList.tsx`, `packages/app/src/components/chat/ChatScreen.tsx` | M |
| S1-D | Artifact save-to-file + clipboard copy — `fs.writeFile` on accepted hunk, `y` to copy raw code to clipboard | `packages/app/src/components/artifacts/ArtifactPanel.tsx`, `packages/app/src/hooks/useArtifacts.ts` | M |

**Decisions required before Sprint 1:**
1. Token counting strategy: approximate (4 chars/token, fast) vs. exact (provider tokenizer, accurate) — pick one
2. `/compact` model: use active provider or hardcoded fast model? (must work on local Ollama)
3. Headless output format: plain text only, or JSON from day one?

---

## Track 2 — Sprint 2: Works Like a Tool (Weeks 3–4)

Depends on Sprint 1 being clean. Can be designed/scaffolded in parallel.

| ID | Feature | Files (approximate) | Size |
|----|---------|---------------------|------|
| S2-A | Headless mode: `uplnk ask "<prompt>"` + stdin pipe — bypass Ink entirely, stream response to stdout, exit 0 | `packages/app/bin/uplnk.ts`, new `packages/app/src/lib/headless.ts` | L |
| S2-B | `/help` + `/clear` + `/retry` + `/tokens` slash commands | `packages/app/src/components/chat/ChatInput.tsx`, `packages/app/src/components/chat/ChatScreen.tsx` | M |

---

## Track 3 — Sprint 3: Stop Punishing Power Users (v0.5)

| ID | Feature | Notes |
|----|---------|-------|
| S3-A | `$TMUX` / `$STY` detection + `--no-alt-screen` flag | One env-var check in `bin/uplnk.ts` |
| S3-B | DevOps toolchain in command allowlist (kubectl, helm, terraform, aws, gcloud, docker, k9s, argocd, flux) | `packages/app/src/lib/mcp/servers/command-exec.ts` or `security.ts` |
| S3-C | Retry + exponential backoff + jitter on 429/5xx | Wrap `streamText` call in `useStream.ts` |
| S3-D | User-definable slash commands / macros via `~/.uplnk/macros.yaml` | Config schema + loader + ChatInput dispatcher |
| S3-E | Config hot-reload (fs.watch on `config.json`) + implement real `$EDITOR` in `uplnk config` | `bin/uplnk.ts:194`, add React Context for config |

---

## Track 4 — Documentation & Brand (independent, start now)

| ID | Item |
|----|------|
| D1 | Full rename pass in README, CONTRIBUTING, INSTALL, all CLI examples, config paths, env vars (`UPLNK_THEME` with deprecation), TUI mockups |
| D2 | Update positioning headline — replace "Local models. Smart routing. Studio-grade UX." with audience-first claim |
| D3 | Add migration note in `uplnk doctor` for `~/.uplnk/` → `~/.uplnk/` with clear user message |
| D4 | Prune features list in README — user-value bullets only; move implementation detail to CHANGELOG |

---

## Track 5 — QA (independent, start now)

| ID | Item |
|----|------|
| Q1 | Audit test coverage gaps — map existing tests to features, identify uncovered paths |
| Q2 | Write integration tests for conversation persistence (including duplicate-row regression) |
| Q3 | Write tests for RAG indexer (including WHERE clause regression) |
| Q4 | Write tests for MCP command allowlist (ensure kubectl/helm etc. work when added) |
| Q5 | Write tests for Relay workflow engine edge cases (abort mid-scout, anchor error, token accumulation) |

---

## Architecture risks to track (do not ship without addressing)

1. Config as frozen prop — `ChatScreen.tsx:65–75` uses `useRef`; future hot-reload requires Context refactor
2. Relay engine uses `textStream` not `fullStream` — tool-call events in Anchor phase are invisible
3. Plugin install trusts HTTP manifests without signature verification
4. No schema migration version check — downgraded binary against newer DB is silent corruption
5. Workflow `useWorkflow.ts` persistence is non-atomic — relay_runs row written before conversation row

---

## Success metrics for "daily driver"

| Signal | Target |
|--------|--------|
| 7-day return rate | ≥ 70% |
| Median session length | ≥ 8 messages |
| Headless invocations | > 0 per user per week |
| Artifact write-backs to disk | ≥ 1 per user per week |
| "thought model had context, it didn't" reports | 0 |
| Duplicate rows in conversations table | 0 |

---

## What NOT to ship next

- More providers (9 is enough; marginal value near zero)
- Web UI / GUI (terminal-native is the differentiator)
- Plugin marketplace (loader works; catalog is a distraction)
- Workflow engine expansion (ship the primitives first)
- Fine-tuning integration (not our job)
