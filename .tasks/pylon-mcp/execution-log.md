# Execution Log — pylon-mcp


## [2026-04-12T09:46:37.674Z] Phase 1: Security sandbox design + approval gate spec -- @security-engineer
Server-recorded completion (agent did not write log entry).

## [2026-04-12T09:47:22.401Z] Phase 2: MCP client infrastructure: StdioClientTransport + McpManager -- @nexus
Server-recorded completion (agent did not write log entry).

## [2026-04-12T09:48:22.185Z] Phase 3: MCP file-browse tool: path allowlist + read-only FS operations -- @staff-engineer
Server-recorded completion (agent did not write log entry).

## [2026-04-12T09:48:22.185Z] Phase 4: MCP command-exec tool: Ink approval dialog + sandboxed execFile -- @staff-engineer
Server-recorded completion (agent did not write log entry).

## [2026-04-12T09:48:22.185Z] Phase 5: Wire MCP tools into useStream + ChatScreen tool loop -- @nexus
Server-recorded completion (agent did not write log entry).

## [2026-04-12T09:48:22.185Z] Phase 6: Config: mcpAllowedPaths + mcpCommandExecEnabled feature flag -- @staff-engineer
Server-recorded completion (agent did not write log entry).

## [2026-04-12T09:49:15.004Z] Phase 7: QA: unit + integration tests for MCP layer -- @qa-engineer
Server-recorded completion (agent did not write log entry).

## [2026-04-12T09:49:39.591Z] Phase 8: Security engineer sign-off review -- @security-engineer
Server-recorded completion (agent did not write log entry).

## [2026-04-12T10:00:00Z] Phase 9: Gap 3 stale streamedText on abort — fix dispatched -- @ceo
Gap 3 already dispatched to staff-engineer prior to this escalation. Marked DONE in plan.

## [2026-04-12T10:01:00Z] Phase 10: Gap 1+2: Wire real MCP servers + transport death handlers -- @ceo
McpManager.ts rewritten:
- Added StreamableHTTPClientTransport import for type:"http" servers (.mcp.json dispatch server)
- connect() now branches on serverConfig.type: 'http' uses StreamableHTTPClientTransport(new URL(...)), 'stdio' uses StdioClientTransport
- transport.onclose / transport.onerror handlers set in connect() (Gap 2) — remove dead connections from map
- Added getRemoteTools(serverId): calls client.listTools(), bridges each tool to AI SDK Tool via jsonSchema() from 'ai', execute() calls client.callTool() and normalises via normalizeMcpToolResult()
- Added getAiSdkToolsAsync(): merges built-in + remote tools from all connected servers
- normalizeMcpToolResult() helper: concatenates text blocks, replaces non-text blocks with "[<type> content]"
- Removed stale createDefaultPolicy import that was unused after refactor

## [2026-04-12T10:02:00Z] Phase 11: Gap 4: useMemo identity stabilisation for mcpTools -- @ceo
useMcp.ts rewritten:
- Added loadMcpJson(repoRoot) helper: reads .mcp.json, parses mcpServers entries into McpServerConfig[]
- useEffect on mount: seeds builtinTools immediately, connects to all .mcp.json servers via Promise.allSettled, then calls getAiSdkToolsAsync() and updates toolMap state
- tools return value is now useMemo(() => toolMap, [toolMap]) — identity only changes when async enumeration completes
- repoRoot option defaulting to process.cwd()
- Removed direct getAiSdkTools() call from render path

## [2026-04-12T10:03:00Z] Phase 12: Gap 5: fullStream migration + tool-running StreamStatus + StatusBar UX -- @ceo
useStream.ts:
- Added 'tool-running' to StreamStatus union
- Added activeToolName: string | null to hook return
- Switched streamText() from destructuring textStream to fullStream
- for-await loop over fullStream: text-delta appends to buffer, tool-call sets status to 'tool-running' + activeToolName, tool-result clears to 'streaming', error throws

StatusBar.tsx:
- Added activeToolName?: string | null prop
- Added 'tool-running' to STATUS_LABELS and STATUS_COLORS (cyan)
- label override: when status is 'tool-running' and activeToolName is set, renders "⚙ running tool: <name>"

ChatScreen.tsx:
- Destructures activeToolName from useStream
- Passes activeToolName to StatusBar

## [2026-04-12T10:04:00Z] Phase 13: Gap 6: Default model llama3.2 → qwen2.5:7b -- @ceo
config.ts: seedDefaultProvider() changed defaultModel from 'llama3.2' to 'qwen2.5:7b' with comment explaining tool-calling reliability.
index.tsx: App component default for initialModel changed from 'llama3.2' to 'qwen2.5:7b'.
Retro log written to internal-doc/nexus-mcp-review-escalation.md.

## [2026-04-12T10:05:00Z] Security verdict: phase 4 BLOCKED, phase 14 added — @ceo
Phase 4 (command-exec) status set to BLOCKED. 6 blocking conditions from security review (BC-1 through BC-6).
file-browse ships once FB-1 TOCTOU fix is merged (in progress in McpManager.ts — resolvedPath now used for all I/O).
Phase 14 added: "Security hardening" gate, depends on epic pylon-mcp-security.
New epic created: internal-task/mcp-security/ (8 phases).
BC-6 audit log implementation applied to McpManager.ts: logToolCall() + appendFileSync + AuditEntry type.
Also applied in same session: FINDING-005 maxDepth cap (max 5, MAX_ENTRIES 500) in buildFileListTool.
Retro at internal-doc/security-verdict-mcp.md.
Command allowlist spec authored (Phase 7) — see pylon-mcp-security execution log.

## [2026-04-12T11:34:36.696Z] Phase 14: Security hardening: command allowlist, per-arg validation, audit log, rate limiting, approval dialog safety (BC-1 through BC-6) -- @security-engineer
Server-recorded completion (agent did not write log entry).
