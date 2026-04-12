# Execution Log — pylon-mcp-security

## [2026-04-12T00:00:00Z] Epic created — @ceo
Epic created following security engineer sign-off verdict (2026-04-12).
command-exec BLOCKED on 6 conditions (BC-1 through BC-6).
file-browse APPROVED WITH CONDITIONS (FB-1 TOCTOU fix in progress).
pylon-mcp phase 4 marked BLOCKED, phase 14 added as gate.
Retro logged at internal-doc/security-verdict-mcp.md.

## [2026-04-12T00:00:30Z] Phase 7: Command allowlist spec authored — @security-engineer (dispatched by @ceo)
Spec produced as structured text output to CEO orchestrator. Key decisions:
- DEFAULT_ALLOWED_COMMANDS: ls, cat, head, tail, wc, file, find, grep, rg, fd, git, tsc, eslint, prettier, npm, pnpm, yarn. npx flagged as borderline — recommend removing from default.
- NEVER_ALLOW set: shells (bash/sh/zsh), interpreters (python3/node/ruby/perl), network (curl/wget/nc/ssh), destructive (rm/mv/cp/chmod/chown), privilege (sudo), obfuscation (openssl/gpg/base64), xargs, tee, osascript, env, brew.
- config.json addition: mcp.commandAllowlistAdditions: string[] — user can add binaries; NEVER_ALLOW entries silently filtered at merge time.
- validateCommand() new enforcement order: NEVER_ALLOW check → allowlist check → which resolution → bin dir check → per-arg metacharacter check → CWD check → existing denylist patterns.
- ALLOWED_BIN_DIRS: /usr/bin, /usr/local/bin, /bin, /sbin, /opt/homebrew/bin (arm64), /home/linuxbrew (Linux). /nix/store optional.
- git -c flag must be blocked in per-arg check (BC-2 concern for git specifically).
- find -exec/-execdir must be blocked in per-arg check.
Full spec in CEO orchestrator response text. Phase 1 implementation should reference this spec.

## [2026-04-12T00:01:00Z] Phase 6 (BC-6): Audit log implementation — @staff-engineer (dispatched by @ceo)
Implemented FINDING-007 audit log in McpManager.ts:
- Added AuditEntry interface (exported) with fields: ts, tool, args, outcome, detail, conversationId
- Added conversationId?: string to McpManagerConfig for per-session correlation
- Added private auditLogPath: string resolved at construction via getPylonDir() + 'mcp-audit.log'
- Constructor now calls mkdirSync(pylonDir, {recursive: true}) to ensure ~/.pylon exists
- Added private logToolCall(entry: AuditEntry): void using appendFileSync (synchronous, cannot be dropped)
  - Error swallowed + written to stderr so audit failures never block the approval gate
- buildFileReadTool: logs denied (path validation fail), denied (size limit), allowed (with sizeBytes), error
  - Also applies FB-1 TOCTOU fix: uses resolvedPath from validateFilePath for all I/O
  - Switched to validateFileSize() from security.ts
- buildFileListTool: logs denied, allowed (with truncated flag)
  - Added effectiveMaxDepth = Math.min(maxDepth ?? 3, 5) hard cap (FINDING-005 partial fix)
  - Added MAX_ENTRIES = 500 cap with truncation marker
  - Also applies FB-1 TOCTOU fix: uses resolvedPath for walk() and relative() calls
- buildCommandExecTool: logs denied (validation), denied (approval gate), allowed (with outputBytes), error
  - args field sanitized: logs command name + argCount, never arg values (may contain paths/secrets)
Added imports: appendFileSync, mkdirSync from node:fs; join from node:path; getPylonDir from pylon-db

## [2026-04-12T11:23:33.934Z] Phase 2: BC-2 (FINDING-002 HIGH): Per-argument metacharacter validation in validateCommand() — blocked pattern list applied to each arg individually -- @staff-engineer
Server-recorded completion (agent did not write log entry).

## [2026-04-12T11:30:13.898Z] Phase 3: BC-3 (FINDING-004 HIGH): Feature flag integrity — one-time interactive confirmation on commandExecEnabled=true, commandExecConfirmedAt timestamp, no in-session reload -- @staff-engineer
Server-recorded completion (agent did not write log entry).

## [2026-04-12T11:30:13.901Z] Phase 4: BC-4 (FINDING-006 MEDIUM): ApprovalDialog safety — de-emphasize LLM description, add AI-generated unverified label, command+args as primary display -- @staff-engineer
Server-recorded completion (agent did not write log entry).

## [2026-04-12T11:30:13.902Z] Phase 5: BC-5 (FINDING-008 MEDIUM): Rate limiting — per-conversation tool call counter (max 100) in useMcp, reduce maxSteps useStream 10→5 -- @staff-engineer
Server-recorded completion (agent did not write log entry).

## [2026-04-12T11:31:36.213Z] Phase 1: BC-1 (FINDING-001 CRITICAL): Implement command allowlist in security.ts — binary name Set, absolute path resolution, allowed bin dir check -- @staff-engineer
Server-recorded completion (agent did not write log entry).

## [2026-04-12T11:31:44.228Z] Phase 6: BC-6 (FINDING-007 MEDIUM): Audit log — append-only JSONL at ~/.pylon/mcp-audit.log, logToolCall() in McpManager using appendFileSync -- @staff-engineer
Server-recorded completion (agent did not write log entry).

## [2026-04-12T11:34:01.587Z] Phase 8: Security re-review: verify BC-1 through BC-6 against base commit d976dab, issue updated sign-off -- @security-engineer
Server-recorded completion (agent did not write log entry).

## [2026-04-12T00:00:00.000Z] Phase 8: Security re-review — @security-engineer

Performed full re-review of BC-1 through BC-6 against the live codebase.

All six blocking conditions PASS. Sign-off document written to:
internal-doc/mcp-security-signoff-v2.md

Summary of findings:
- BC-1 (CRITICAL — allowlist): PASS. NEVER_ALLOW_COMMANDS checked first at line 357, allowlist at lines 378-391, which resolution at lines 393-400, bin-dir at lines 402-410. NEVER_ALLOW entries are deleted from the effective allowedSet even when present in additionalAllowed (lines 382-384) — config cannot override permanent block.
- BC-2 (HIGH — per-arg validation): PASS. validateCommandArgs() exported at line 296, called at line 414. All required patterns implemented: 8 shell metacharacters, path traversal, null bytes, git -c/--upload-pack/--receive-pack/--exec, find -exec/-execdir.
- BC-3 (HIGH — feature flag confirmation): PASS. commandExecConfirmedAt in schema (config.ts line 45). useMcp requires BOTH commandExecEnabled===true AND valid ISO timestamp (lines 134-138). pylon config --confirm-command-exec sets both fields (pylon.ts lines 84-112). Startup warning present (lines 258-270).
- BC-4 (MEDIUM — ApprovalDialog): PASS. Command+args as bold primary display (lines 73-83), LLM description labeled "AI description (unverified):" with dimColor on both label and body (lines 94-103). No default — only 'y' approves.
- BC-5 (MEDIUM — rate limiting): PASS. MAX_TOOL_CALLS_PER_CONVERSATION=100 exported (useMcp.ts line 34). Counter reset on conversationId change (lines 241-243). Limit check returns error without calling through (lines 265-275). maxSteps=5 in useStream.ts line 114.
- BC-6 (MEDIUM — audit log): PASS. AuditEntry exported (McpManager.ts line 62). appendFileSync used (line 192). Full tool coverage: file-browse (read/list/write/patch), command-exec, git (status/diff/stage/commit), rag (search/index). File content and raw arg values not logged — byteLength and argCount used instead.

Three non-blocking observations documented in sign-off (allowlist overlap, startup warning completeness, rate-limit off-by-one). None affect security posture.

Final verdict: APPROVED. commandExecEnabled cleared to ship in v0.2.
