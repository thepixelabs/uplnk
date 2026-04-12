---
epic: pylon-mcp-security
phases:
  - id: 1
    title: "BC-1 (FINDING-001 CRITICAL): Implement command allowlist in security.ts — binary name Set, absolute path resolution, allowed bin dir check"
    persona: staff-engineer
    status: DONE
    notes: "DEFAULT_ALLOWED_COMMANDS, NEVER_ALLOW_COMMANDS (Set), ALLOWED_BIN_DIRS exported constants. validateCommand() enforces: NEVER_ALLOW → allowlist → which resolution → bin dir check. additionalAllowed param for config extensions. commandAllowlistAdditions in config.ts mcp schema."
  - id: 2
    title: "BC-2 (FINDING-002 HIGH): Per-argument metacharacter validation in validateCommand() — blocked pattern list applied to each arg individually"
    persona: staff-engineer
    status: DONE
  - id: 3
    title: "BC-3 (FINDING-004 HIGH): Feature flag integrity — one-time interactive confirmation on commandExecEnabled=true, commandExecConfirmedAt timestamp, no in-session reload"
    persona: staff-engineer
    status: DONE
  - id: 4
    title: "BC-4 (FINDING-006 MEDIUM): ApprovalDialog safety — de-emphasize LLM description, add AI-generated unverified label, command+args as primary display"
    persona: staff-engineer
    status: DONE
  - id: 5
    title: "BC-5 (FINDING-008 MEDIUM): Rate limiting — per-conversation tool call counter (max 100) in useMcp, reduce maxSteps useStream 10→5"
    persona: staff-engineer
    status: DONE
  - id: 6
    title: "BC-6 (FINDING-007 MEDIUM): Audit log — append-only JSONL at ~/.pylon/mcp-audit.log, logToolCall() in McpManager using appendFileSync"
    persona: staff-engineer
    status: DONE
    notes: "AuditEntry interface exported. auditLogPath resolved in constructor to ~/.pylon/mcp-audit.log. logToolCall() appends JSONL via appendFileSync (synchronous, never drops entries). Full coverage: file-read/list/write/patch, command-exec, git, rag tools. Never logs file content or arg values for security."
  - id: 7
    title: "Command allowlist spec: finalize default allowlist binaries, config.json schema for user overrides, enforcement contract in validateCommand()"
    persona: security-engineer
    status: DONE
    notes: "Spec implemented as code in BC-1: DEFAULT_ALLOWED_COMMANDS (28 binaries), NEVER_ALLOW_COMMANDS (40+ permanently blocked), ALLOWED_BIN_DIRS (6 trusted paths). config.mcp.commandAllowlistAdditions in schema."
  - id: 8
    title: "Security re-review: verify BC-1 through BC-6 against base commit d976dab, issue updated sign-off"
    persona: security-engineer
    status: DONE
---

## Context & Objective

This epic tracks the 6 blocking conditions (BC-1 through BC-6) identified in the MCP security
review (2026-04-12) that prevent `commandExecEnabled` from being enabled in any user-facing
configuration. Until all phases are DONE and Phase 8 (re-review sign-off) is DONE, `command-exec`
remains feature-flagged disabled.

**Reference documents:**
- `internal-doc/mcp-security-review.md` — full findings
- `internal-doc/mcp-security-signoff.md` — sign-off with blocking conditions
- Base commit for re-review diff: `d976dab`

**What ships before this epic completes (v0.1):**
- `mcp_file_read` and `mcp_file_list` (file-browse) — approved with single condition FB-1 (TOCTOU
  fix, in progress separately under pylon-mcp phase 3/staff-engineer)
- All in-process tools, chat, model selector, conversation persistence

**What ships when this epic completes (v0.2):**
- `mcp_command_exec` with full three-layer defense: allowlist + per-arg validation + approval gate
- Audit log at `~/.pylon/mcp-audit.log`
- Rate limiting (max 100 tool calls/conversation)
- Hardened ApprovalDialog

**Phases 1–6** are implementation work assigned to staff-engineer.
**Phase 7** is the allowlist spec authored by security-engineer (feeds Phase 1 implementation).
**Phase 8** is the focused re-review by security-engineer — trigger only after Phases 1–6 are DONE.

Phase 7 (spec) should ideally complete before or in parallel with Phase 1 (implementation).
The security-engineer spec output must be referenced by the Phase 1 implementor.
