/**
 * McpManager — lifecycle management for MCP server connections.
 *
 * Architecture (ref: 07-nexus-protocols-v2.md, 06-system-architecture-v2.md,
 * arch-critical-fixes Phase 4 / ADR-004):
 * - Uses @modelcontextprotocol/sdk Client + StdioClientTransport (stdio servers)
 *   or StreamableHTTPClientTransport (HTTP servers per .mcp.json type:"http")
 * - Spawns child processes: built-in servers (file-browse, command-exec) are
 *   separate stdio MCP child processes, not in-process handlers.
 * - Security validation (path checking, command validation, approval gating)
 *   runs in THIS parent process BEFORE forwarding JSON-RPC calls to children.
 * - Manages one Client per server connection
 * - Exposes a unified tool registry for integration with Vercel AI SDK
 * - Bridges remote MCP tools via listTools() → AI SDK Tool using jsonSchema() from 'ai'
 * - Calls remote tools via client.callTool() with content normalization
 *
 * Feature flag: commandExecEnabled controls whether command-exec child is spawned.
 * Defaults to false until security sign-off.
 *
 * Transport death (Gap 2): onclose/onerror handlers on each transport mark the
 * connection closed/error and remove it from the active connections map.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { jsonSchema, type Tool } from 'ai';
import { appendFileSync, mkdirSync, statSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFilePath, validateCommand, validateFileSize } from './security.js';
import type { FileAccessPolicy } from './security.js';
import { getUplnkDir } from '@uplnk/db';

// ─── Built-in server resolution ──────────────────────────────────────────────

const __mcpDir = dirname(fileURLToPath(import.meta.url));
// Runtime is Bun (≥ 1.1.30) for both dev (.ts source) and compiled binary (.js).
// process.execPath is the Bun binary in dev and the compiled uplnk binary in prod;
// both run .ts/.js MCP server scripts natively.
const isTsSource = import.meta.url.endsWith('.ts');
const serverExt = isTsSource ? 'ts' : 'js';
const serverCmd = process.execPath;

/** Sentinel IDs for the built-in child-process servers. */
export const BUILTIN_FILE_BROWSE_ID = '__uplnk_builtin_file_browse__';
export const BUILTIN_COMMAND_EXEC_ID = '__uplnk_builtin_command_exec__';
export const BUILTIN_GIT_ID = '__uplnk_builtin_git__';
export const BUILTIN_RAG_ID = '__uplnk_builtin_rag__';

const BUILTIN_SERVER_IDS: ReadonlySet<string> = new Set([
  BUILTIN_FILE_BROWSE_ID,
  BUILTIN_COMMAND_EXEC_ID,
  BUILTIN_GIT_ID,
  BUILTIN_RAG_ID,
]);

// ─── Auto-reconnect tuning (E.3.3) ──────────────────────────────────────────
// Built-in MCP children can die for many mundane reasons (OOM, signal, write
// to a closed pipe). We auto-restart them with exponential backoff so a
// transient crash doesn't permanently strip the LLM of its tools. External
// servers are NOT auto-reconnected — users configured them explicitly and
// should see the failure in /mcp. Cap retries at 3 to avoid a hot loop when
// the child is genuinely broken (e.g. corrupt binary).
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_ATTEMPTS = 3;

/**
 * Cap external MCP tool descriptions at this character count.
 * External (user-configured) servers can return arbitrary description text
 * which gets injected verbatim into the LLM's tool schema block. A hostile
 * server might pack injection payloads into a long description. We cap it at
 * a length large enough for a normal one-liner but small enough that a payload
 * is meaningfully truncated. Built-in tools are not affected.
 *
 * The 150-char threshold matches the analysis recommendation in
 * plans/odysseus-competitive-analysis.md §4 Phase A item 0.6.
 */
const EXTERNAL_DESCRIPTION_MAX = 150;

/**
 * Sanitize a tool description received from an external MCP server.
 * - Strip control characters (no \r\n\t injection into the JSON schema).
 * - Strip strings that look like role markers or "ignore previous" prompts.
 * - Truncate to EXTERNAL_DESCRIPTION_MAX with an ellipsis.
 *
 * Built-in tool descriptions bypass this entirely — they're our own strings.
 */
export function sanitizeExternalToolDescription(raw: string | undefined, toolName: string): string {
  if (raw === undefined || raw.trim() === '') return toolName;
  // Strip ASCII control chars (0x00-0x1F and 0x7F DEL) by char code so a
  // description can't smuggle newlines/tabs into the JSON tool schema. We
  // build the cleaned string char-by-char rather than via a regex literal
  // because regex literals containing raw control bytes are fragile to
  // round-trip through editing tools.
  let cleaned = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      cleaned += ' ';
    } else {
      cleaned += raw[i];
    }
  }
  // Collapse delimiter-like markers from promptSecurity so a hostile MCP
  // server cannot piggyback on uplnk's own untrusted-context protocol.
  cleaned = cleaned.replace(/<<<UNTRUSTED_SOURCE_DATA[^>]*>>>/g, '[redacted]');
  cleaned = cleaned.replace(/<<<END_UNTRUSTED_SOURCE_DATA>>>/g, '[redacted]');
  cleaned = cleaned.trim().replace(/\s+/g, ' ');
  if (cleaned.length > EXTERNAL_DESCRIPTION_MAX) {
    cleaned = cleaned.slice(0, EXTERNAL_DESCRIPTION_MAX - 1) + '…';
  }
  return cleaned.length > 0 ? cleaned : toolName;
}

// ─── Audit log types ──────────────────────────────────────────────────────────

/**
 * Shape of a single audit log entry written to ~/.uplnk/mcp-audit.log.
 *
 * Security rules for the args field:
 * - Include ONLY structural metadata: paths, command names, boolean flags, byte counts.
 * - NEVER include file contents, stdout/stderr output, or any value that may
 *   contain secrets. The audit log itself could be read by an attacker who gains
 *   local filesystem access — keep it metadata-only.
 *
 *: No MCP tool call audit log.
 */
export interface AuditEntry {
  ts: string; // ISO 8601
  tool: string; // e.g. "mcp_file_read"
  args: Record<string, unknown>; // sanitized — paths/commands only, never content
  outcome: 'allowed' | 'denied' | 'error';
  detail?: string; // reason on denied/error, summary on allowed
  conversationId?: string;
  /**
   * Monotonic catalog generation at the time of the call. Useful when
   * the tool list is mutable (e.g. servers implementing tools/list_changed
   * with a find_tools meta-tool that re-publishes the catalog mid-session).
   * Distinguishes a call to "kick_diagnose v1" from "kick_diagnose v2"
   * published later in the same conversation. Set by McpManager whenever
   * a refresh occurs.
   */
  catalogGeneration?: number;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  /** Unique identifier for this server */
  id: string;
  /** Display name */
  name: string;
  /**
   * Transport type.
   * - "stdio": spawn a subprocess (requires command)
   * - "http": connect to a StreamableHTTP MCP endpoint (requires url)
   * Defaults to "stdio" for backwards compatibility.
   */
  type?: 'stdio' | 'http';
  /** Executable command to spawn (stdio transport only) */
  command?: string;
  /** Arguments to pass to the executable (stdio transport only) */
  args?: string[];
  /** Environment variables for the subprocess (stdio transport only) */
  env?: Record<string, string>;
  /** HTTP endpoint URL (http transport only) */
  url?: string;
}

export interface McpManagerConfig {
  /** Filesystem access policy */
  filePolicy: FileAccessPolicy;
  /**
   * Feature flag — command-exec tool is only registered when true.
   * Default: false (requires security sign-off).
   */
  commandExecEnabled: boolean;
  /**
   * Feature flag — git tools are registered when true.
   * Default: true (git operations are read-heavy; writes require approval gate).
   */
  gitEnabled: boolean;
  /**
   * Feature flag — RAG tools (semantic codebase search + indexing) are
   * registered when true. mcp_rag_search is read-only; mcp_rag_index
   * requires directory validation against allowedRoots.
   * Default: false until embedding model is configured.
   */
  ragEnabled: boolean;
  /**
   * Optional embedding config forwarded to the RAG child process via env vars.
   * Required for mcp_rag_search to work (mcp_rag_index can run without embeddings
   * to pre-populate chunks for later embedding).
   */
  ragEmbedConfig?: {
    baseUrl: string;
    apiKey: string;
    model: string;
  } | undefined;
  /**
   * Called when a tool call needs user approval (command-exec, git stage/commit).
   * Must return a promise that resolves to true (approved) or false (denied).
   */
  requestApproval: (request: {
    id: string;
    command: string;
    args: string[];
    cwd?: string;
    description?: string;
  }) => Promise<boolean>;
  /**
   * Optional conversation ID injected by useMcp.ts for audit log correlation.
   * Each tool call audit entry includes this value so entries can be grouped
   * by conversation in post-incident analysis.
   */
  conversationId?: string;
}

interface ServerConnection {
  config: McpServerConfig;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  status: 'connecting' | 'connected' | 'error' | 'closed';
  error?: Error;
}

/**
 * Snapshot of a server that failed to connect at startup. Kept separately
 * from the live connections map so the UI can show "N servers failed —
 * /mcp" without us having to keep the dead client around.
 */
export interface FailedConnection {
  config: McpServerConfig;
  error: Error;
  /** Last ~40 lines of the child process's stderr, joined with `\n`. */
  stderrTail: string;
}

const STDERR_TAIL_LINES = 40;

// ─── McpManager ───────────────────────────────────────────────────────────────

/**
 * Per-builtin reconnect state. Only populated for IDs in BUILTIN_SERVER_IDS;
 * external connections are never auto-restarted.
 *
 * - `config`: the original McpServerConfig captured at first connect(), used
 *   to re-spawn the child. Configs are immutable in practice (sourced from
 *   constants), so we hold a reference rather than cloning.
 * - `attempts`: number of consecutive failed reconnect attempts. Reset to 0
 *   on any successful connect(), so a built-in that connects, crashes, and
 *   reconnects cleanly only "spends" one cycle.
 * - `timer`: handle for the pending backoff setTimeout, or null if no retry
 *   is scheduled. Used by destroy() and explicit disconnect() to cancel.
 * - `inFlight`: true while a reconnect attempt is actively running. Prevents
 *   the close+error race: when a child dies the SDK fires onerror THEN
 *   onclose, and we'd otherwise schedule the same reconnect twice.
 */
interface ReconnectState {
  config: McpServerConfig;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
}

export class McpManager {
  private readonly connections = new Map<string, ServerConnection>();
  private readonly failedConnections = new Map<string, FailedConnection>();
  private readonly reconnectState = new Map<string, ReconnectState>();
  private readonly config: McpManagerConfig;
  private destroyed = false;
  /** Resolved once at construction so all logToolCall() calls use the same path. */
  private readonly auditLogPath: string;

  /**
   * Monotonic catalog generation, incremented on every successful
   * `tools/list_changed` refresh from any connected server. Stamped onto
   * every AuditEntry so a post-incident analyst can distinguish a call
   * made against catalog version N from one made against N+1.
   */
  private catalogGeneration = 0;

  /** Listeners notified when any server publishes a list_changed refresh. */
  private readonly toolsChangedListeners = new Set<(serverId: string) => void>();

  /**
   * Subscribe to tools/list_changed notifications across every connected
   * server. The callback fires after `catalogGeneration` is incremented;
   * subscribers (useMcp) should refresh `setToolMap(await getAiSdkToolsAsync())`.
   * Returns an unsubscribe handle.
   */
  subscribeToolsChanged(cb: (serverId: string) => void): () => void {
    this.toolsChangedListeners.add(cb);
    return () => {
      this.toolsChangedListeners.delete(cb);
    };
  }

  /** Current monotonic catalog generation. */
  getCatalogGeneration(): number {
    return this.catalogGeneration;
  }

  private notifyToolsChanged(serverId: string): void {
    for (const cb of Array.from(this.toolsChangedListeners)) {
      try {
        cb(serverId);
      } catch (err) {
        process.stderr.write(
          `[uplnk mcp] toolsChanged listener threw: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  constructor(config: McpManagerConfig) {
    this.config = config;
    const uplnkDir = getUplnkDir();
    // Ensure ~/.uplnk exists. Normally created by getOrCreateConfig() in config.ts,
    // but McpManager may be instantiated in test contexts before that runs.
    try {
      mkdirSync(uplnkDir, { recursive: true });
    } catch {
      // If mkdir fails we proceed — logToolCall() swallows errors so the app
      // never crashes on audit log failures.
    }
    this.auditLogPath = join(uplnkDir, 'mcp-audit.log');
  }

  // ─── Audit log ──────────────────────────────────────────────────────────────

  /**
   * Append a single JSONL entry to ~/.uplnk/mcp-audit.log.
   *
   * Uses appendFileSync (synchronous) so the entry is written before control
   * returns to the caller — entries cannot be silently dropped on process exit
   * or an unhandled promise rejection.
   *
   * This method MUST NEVER throw. Audit failures are swallowed and written to
   * stderr so they do not block the tool approval gate or execution path.
   *
   *: No MCP tool call audit log.
   */
  /**
   * Maximum size of the audit log before it gets rotated, in bytes.
   * 10 MB keeps ~30 days of heavy use in one file and fits comfortably in
   * small `/home` partitions (Marcus's air-gapped cluster requirement).
   */
  private static readonly AUDIT_LOG_MAX_BYTES = 10 * 1024 * 1024;

  /**
   * Rotate the audit log when it exceeds AUDIT_LOG_MAX_BYTES. We keep
   * exactly one backup (`.1`) and clobber the previous backup on each
   * rotation — enough for forensics, bounded for disk usage.
   *
   * This runs synchronously before every append so rotation is race-free
   * across concurrent uplnk processes sharing the same log file: worst
   * case two processes both rotate and overwrite .1, which is acceptable.
   */
  private rotateAuditLogIfNeeded(): void {
    try {
      const stat = statSync(this.auditLogPath);
      if (stat.size < McpManager.AUDIT_LOG_MAX_BYTES) return;
      const backupPath = `${this.auditLogPath}.1`;
      if (existsSync(backupPath)) {
        try { unlinkSync(backupPath); } catch { /* ignore */ }
      }
      renameSync(this.auditLogPath, backupPath);
    } catch {
      // File missing → nothing to rotate. Any other error is swallowed
      // because logToolCall must never throw; the next append will create
      // a fresh file.
    }
  }

  private logToolCall(entry: AuditEntry): void {
    try {
      this.rotateAuditLogIfNeeded();
      // Stamp the current catalog generation so post-incident analysis can
      // distinguish calls against successive tools/list snapshots. Phase 12f.
      const stamped: AuditEntry = entry.catalogGeneration !== undefined
        ? entry
        : { ...entry, catalogGeneration: this.catalogGeneration };
      const line = JSON.stringify(stamped) + '\n';
      appendFileSync(this.auditLogPath, line, { encoding: 'utf-8', flag: 'a' });
    } catch (err) {
      // Never let an audit failure crash the app or block execution.
      process.stderr.write(
        `[uplnk audit] WARNING: failed to write audit log entry: ${String(err)}\n`,
      );
    }
  }

  // ─── Server lifecycle ───────────────────────────────────────────────────────

  async connect(serverConfig: McpServerConfig): Promise<void> {
    if (this.destroyed) {
      throw new Error('McpManager has been destroyed');
    }

    if (this.connections.has(serverConfig.id)) {
      return; // Already connected
    }

    // A retry through connect() means the previous failure is no longer
    // current — clear it so a successful connect doesn't leave a stale
    // entry hanging around for the UI to display.
    this.failedConnections.delete(serverConfig.id);

    const transportType = serverConfig.type ?? 'stdio';
    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    // Captures the last STDERR_TAIL_LINES of the child process's stderr so
    // /mcp can show the user what actually went wrong. For http transports
    // this stays empty.
    const stderrLines: string[] = [];
    let stderrBuffer = '';

    if (transportType === 'http') {
      if (serverConfig.url === undefined) {
        throw new Error(`MCP server "${serverConfig.id}" has type "http" but no url`);
      }
      transport = new StreamableHTTPClientTransport(new URL(serverConfig.url));
    } else {
      if (serverConfig.command === undefined) {
        throw new Error(`MCP server "${serverConfig.id}" has type "stdio" but no command`);
      }
      // stderr: 'pipe' keeps child process error output off our Ink alt-screen.
      // The SDK exposes the piped stream via transport.stderr.
      const stdioTransport = new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args ?? [],
        ...(serverConfig.env !== undefined ? { env: serverConfig.env } : {}),
        stderr: 'pipe',
      });
      stdioTransport.stderr?.on('data', (chunk: Buffer | string) => {
        stderrBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const parts = stderrBuffer.split('\n');
        stderrBuffer = parts.pop() ?? '';
        for (const line of parts) {
          stderrLines.push(line);
          if (stderrLines.length > STDERR_TAIL_LINES) stderrLines.shift();
        }
      });
      transport = stdioTransport;
    }

    const client = new Client(
      { name: 'uplnk', version: '0.3.0' },
      {
        // Advertise that we can handle list-changed notifications so polite
        // servers actually send them. Per MCP spec 2025-11-25, servers
        // that declare `tools.listChanged` SHOULD only emit
        // `notifications/tools/list_changed` to clients that advertise
        // they handle it.
        capabilities: { tools: { listChanged: true } },
        // SDK option that auto-wires a tools/list_changed handler and
        // re-invokes listTools() under the hood. We surface the event via
        // notifyToolsChanged so useMcp can refresh setToolMap and the next
        // chat turn picks up the new catalog.
        listChanged: {
          tools: {
            autoRefresh: true,
            debounceMs: 150,
            onChanged: (err: Error | null, _tools?: unknown) => {
              if (err !== null) {
                process.stderr.write(
                  `[uplnk mcp] tools/list_changed refresh failed for ${serverConfig.id}: ${err.message}\n`,
                );
                return;
              }
              this.catalogGeneration += 1;
              this.notifyToolsChanged(serverConfig.id);
            },
          },
        },
      } as ConstructorParameters<typeof Client>[1],
    );

    const conn: ServerConnection = {
      config: serverConfig,
      client,
      transport,
      status: 'connecting',
    };
    this.connections.set(serverConfig.id, conn);

    // Gap 2: Transport death handlers — if the underlying transport closes or
    // errors unexpectedly (e.g. subprocess exits, HTTP connection drops), mark
    // the connection as closed/error and remove it from the map so callers
    // don't attempt to use a dead client.
    //
    // E.3.3: For built-in servers we also schedule an auto-reconnect via
    // _scheduleReconnect(). The scheduler itself dedupes (inFlight + timer
    // checks), so an onerror+onclose pair only ever produces one retry.
    transport.onclose = () => {
      const existing = this.connections.get(serverConfig.id);
      if (existing !== undefined) {
        existing.status = 'closed';
        this.connections.delete(serverConfig.id);
      }
      this._maybeScheduleReconnect(serverConfig.id);
    };

    transport.onerror = (err: Error) => {
      const existing = this.connections.get(serverConfig.id);
      if (existing !== undefined) {
        existing.status = 'error';
        existing.error = err;
        this.connections.delete(serverConfig.id);
      }
      this._maybeScheduleReconnect(serverConfig.id);
    };

    try {
      // exactOptionalPropertyTypes: StreamableHTTPClientTransport.sessionId is
      // typed string|undefined in the SDK but Transport requires string. Both
      // transports satisfy the runtime Transport contract — cast to suppress.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await client.connect(transport as any);
      conn.status = 'connected';
      // E.3.3: Register the built-in for auto-reconnect (or reset its retry
      // counter if it already existed — see step 7 in the task spec).
      // External servers stay out of the reconnect map by design.
      //
      // Race: an `onclose` from a stale transport can fire between this
      // success path and the next microtask, scheduling a fresh retry timer
      // on the existing state entry. We must NOT clobber that timer here —
      // only reset the give-up counter and inFlight. If no entry exists
      // (first ever connect) we create one fresh.
      if (BUILTIN_SERVER_IDS.has(serverConfig.id)) {
        const prior = this.reconnectState.get(serverConfig.id);
        if (prior === undefined) {
          this.reconnectState.set(serverConfig.id, {
            config: serverConfig,
            attempts: 0,
            timer: null,
            inFlight: false,
          });
        } else {
          prior.config = serverConfig;
          prior.attempts = 0;
          prior.inFlight = false;
          // prior.timer is intentionally preserved.
        }
      }
    } catch (err) {
      conn.status = 'error';
      const wrapped = err instanceof Error ? err : new Error(String(err));
      conn.error = wrapped;
      this.connections.delete(serverConfig.id);
      // Built-ins are an implementation detail — surfacing their failures in
      // /mcp would just confuse users. Only record user-configured servers.
      if (!serverConfig.id.startsWith('__uplnk_builtin_')) {
        const tail = [...stderrLines];
        if (stderrBuffer.length > 0) tail.push(stderrBuffer);
        this.failedConnections.set(serverConfig.id, {
          config: serverConfig,
          error: wrapped,
          stderrTail: tail.join('\n'),
        });
      }
      throw wrapped;
    }
  }

  /**
   * Snapshot of every server that failed at connect time and hasn't been
   * successfully retried. Consumed by ChatScreen + the /mcp status screen.
   */
  getFailedConnections(): FailedConnection[] {
    return [...this.failedConnections.values()];
  }

  /**
   * Configured servers that are not currently connected and not in the
   * failed-connections map either — typically because retry hasn't been
   * attempted yet. Used by /mcp to enumerate every server the user
   * configured, even if they connected fine.
   */
  isConnected(serverId: string): boolean {
    const conn = this.connections.get(serverId);
    return conn !== undefined && conn.status === 'connected';
  }

  async disconnect(serverId: string): Promise<void> {
    // E.3.3: Explicit disconnect cancels auto-reconnect — the user/app meant
    // to take the server down. A later connect() call will re-register the
    // entry. We clear BEFORE closing the transport so the onclose handler
    // (which will fire as a side effect of client.close()) sees no entry
    // and skips scheduling.
    this._clearReconnectState(serverId);

    const conn = this.connections.get(serverId);
    if (conn === undefined) return;

    try {
      await conn.client.close();
    } catch {
      // Best-effort close
    }
    conn.status = 'closed';
    this.connections.delete(serverId);
  }

  async destroy(): Promise<void> {
    // Mark destroyed BEFORE clearing timers so any timer that fires
    // concurrently with destroy() (unlikely but possible) bails in
    // _maybeScheduleReconnect's destroyed-check rather than re-scheduling.
    this.destroyed = true;
    for (const state of this.reconnectState.values()) {
      if (state.timer !== null) clearTimeout(state.timer);
      state.timer = null;
    }
    this.reconnectState.clear();
    const ids = [...this.connections.keys()];
    await Promise.allSettled(ids.map((id) => this.disconnect(id)));
  }

  // ─── Auto-reconnect (E.3.3) ─────────────────────────────────────────────────

  /** Cancel any pending reconnect timer and remove the entry. */
  private _clearReconnectState(serverId: string): void {
    const state = this.reconnectState.get(serverId);
    if (state === undefined) return;
    if (state.timer !== null) clearTimeout(state.timer);
    this.reconnectState.delete(serverId);
  }

  /**
   * Called from transport.onclose/onerror. Decides whether the death warrants
   * a retry and, if so, hands off to _scheduleReconnect. Guards:
   * - destroyed manager → no-op (we're shutting down).
   * - non-builtin id → no-op (external servers aren't auto-reconnected).
   * - no reconnectState entry → no-op (user explicitly disconnect()'d).
   */
  private _maybeScheduleReconnect(serverId: string): void {
    if (this.destroyed) return;
    if (!BUILTIN_SERVER_IDS.has(serverId)) return;
    const state = this.reconnectState.get(serverId);
    if (state === undefined) return;
    this._scheduleReconnect(serverId);
  }

  /**
   * Schedule the next backoff-delayed reconnect attempt for a built-in server.
   * Idempotent under the close+error race: if a timer is already pending OR
   * an attempt is in flight, the call is a no-op. Walks 500/1000/2000 ms then
   * gives up at RECONNECT_MAX_ATTEMPTS (logging once).
   */
  private _scheduleReconnect(serverId: string): void {
    const state = this.reconnectState.get(serverId);
    if (state === undefined) return;
    // Dedup: an in-flight attempt or a pending timer already covers this server.
    if (state.inFlight) return;
    if (state.timer !== null) return;
    if (state.attempts >= RECONNECT_MAX_ATTEMPTS) {
      // Give up. The entry stays in the map so getConnectionStatus() callers
      // can see the server is gone; a subsequent app-level connect() will
      // reset attempts to 0 and re-arm the machinery.
      process.stderr.write(
        `[uplnk mcp] WARNING: gave up auto-reconnecting "${serverId}" after ${state.attempts} attempts\n`,
      );
      return;
    }

    // 500 * 2^attempts — attempts=0 → 500ms, 1 → 1s, 2 → 2s.
    const delay = RECONNECT_BASE_MS * Math.pow(2, state.attempts);
    state.timer = setTimeout(() => {
      void this._fireReconnect(serverId);
    }, delay);
  }

  /**
   * Timer callback. Runs the actual connect() attempt and recurses on failure.
   * Kept separate from _scheduleReconnect so the setTimeout callback is a
   * thin shim — easier to reason about in fake-timer tests.
   */
  private async _fireReconnect(serverId: string): Promise<void> {
    const state = this.reconnectState.get(serverId);
    if (state === undefined) return;
    // The timer fired and is consumed; null it before doing async work so
    // a concurrent _scheduleReconnect (e.g. from a stray onclose) sees a
    // free slot and the inFlight guard does its job.
    state.timer = null;
    if (this.destroyed) return;
    state.inFlight = true;
    try {
      await this.connect(state.config);
    } catch {
      // connect() failed. Re-read the state — connect() may have mutated it
      // (it sets attempts=0 on success, but on the failure path it just
      // re-throws). Increment and schedule the next backoff step.
      const afterFail = this.reconnectState.get(serverId);
      if (afterFail === undefined) return; // disconnect() called during the attempt
      afterFail.inFlight = false;
      afterFail.attempts += 1;
      this._scheduleReconnect(serverId);
      return;
    }
    // Success path. Clear inFlight first so any reconnect logic below can
    // proceed — connect()'s success path already reset attempts to 0 and
    // set inFlight to false, but we redo it explicitly here as a guard.
    const after = this.reconnectState.get(serverId);
    if (after === undefined) return;
    after.inFlight = false;

    // Race: an onclose could have fired during the connect() await window
    // (after the SDK's client.connect resolved but before our success
    // post-await code ran). In that case _maybeScheduleReconnect short-
    // circuited on inFlight=true and the death was silently dropped.
    // Detect it by checking the connections map — if the entry is gone,
    // schedule another cycle. attempts stays at 0 because the connect
    // itself succeeded; this is a "fresh start" retry.
    if (!this.connections.has(serverId)) {
      this._scheduleReconnect(serverId);
      return;
    }

    // Verify the connection by listing tools once — surfaces a half-open
    // transport (connect succeeded but the child is wedged) as a soft signal.
    // We don't treat listTools failure as a reconnect trigger because the
    // SDK will eventually emit onerror/onclose for a truly dead transport.
    const conn = this.connections.get(serverId);
    if (conn !== undefined) {
      try {
        const tools = await conn.client.listTools();
        process.stderr.write(
          `[uplnk mcp] reconnected "${serverId}" (${tools.tools.length} tools)\n`,
        );
      } catch {
        // listTools failed — let a subsequent transport death (which the
        // SDK will emit for a truly dead child) drive the next reconnect.
      }
    }
  }

  // ─── Remote tool bridge (Gap 1) ─────────────────────────────────────────────

  /**
   * Fetches live tool definitions from a connected MCP server and returns them
   * as Vercel AI SDK Tool objects using jsonSchema() from 'ai'.
   *
   * The execute() callback calls client.callTool() and normalises the response
   * content array (MCP spec returns typed blocks) into a plain string for the
   * AI SDK tool result pipeline.
   */
  async getRemoteTools(serverId: string): Promise<Record<string, Tool>> {
    const conn = this.connections.get(serverId);
    if (conn === undefined || conn.status !== 'connected') {
      return {};
    }

    let toolsResult: Awaited<ReturnType<Client['listTools']>>;
    try {
      toolsResult = await conn.client.listTools();
    } catch {
      return {};
    }

    const tools: Record<string, Tool> = {};
    const isBuiltin = BUILTIN_SERVER_IDS.has(serverId);

    for (const mcpTool of toolsResult.tools) {
      const toolName = mcpTool.name;
      const inputSchema = mcpTool.inputSchema as Record<string, unknown>;
      const client = conn.client;

      // Built-in tools: trust the description verbatim — they're our own strings.
      // External servers: cap + sanitize so a hostile server cannot smuggle
      // injection payloads into the LLM's tool-schema block. See A.0.6.
      const safeDescription = isBuiltin
        ? (mcpTool.description ?? toolName)
        : sanitizeExternalToolDescription(mcpTool.description, toolName);

      tools[toolName] = {
        description: safeDescription,
        // jsonSchema() from 'ai' accepts a raw JSON Schema object — no Zod needed
        // for remote tools since we receive the schema from the server at runtime.
        parameters: jsonSchema(inputSchema as Parameters<typeof jsonSchema>[0]),
        execute: async (args: Record<string, unknown>): Promise<string> => {
          const result = await client.callTool({ name: toolName, arguments: args });
          return normalizeMcpToolResult(result);
        },
        // Preserve MCP-spec metadata so downstream consumers (McpStatusPanel,
        // future help screens, deprecation-aware filters) can read it. The
        // AI SDK ignores unknown fields, so they pass through harmlessly.
        ...((mcpTool as { annotations?: unknown }).annotations !== undefined
          ? { annotations: (mcpTool as { annotations?: unknown }).annotations }
          : {}),
        ...((mcpTool as { _meta?: unknown })._meta !== undefined
          ? { _meta: (mcpTool as { _meta?: unknown })._meta }
          : {}),
        ...((mcpTool as { title?: unknown }).title !== undefined
          ? { title: (mcpTool as { title?: unknown }).title }
          : {}),
      } as Tool & {
        annotations?: unknown;
        _meta?: unknown;
        title?: unknown;
      };
    }

    return tools;
  }

  // ─── Built-in server lifecycle ──────────────────────────────────────────────

  /**
   * Spawn the built-in child-process MCP servers (file-browse, and optionally
   * command-exec) and connect to them via StdioClientTransport.
   *
   * Call this once from useMcp's mount effect. Connections are idempotent —
   * calling connectBuiltins() twice is safe (second call is a no-op per
   * McpManager.connect()'s existing idempotency guarantee).
   *
   * C3 fix — arch-critical-fixes Phase 4 (ADR-004): built-in tools run in
   * isolated child processes instead of in the parent's process space.
   */
  async connectBuiltins(): Promise<void> {
    const fileBrowseScript = join(__mcpDir, 'servers', `file-browse.${serverExt}`);
    await this.connect({
      id: BUILTIN_FILE_BROWSE_ID,
      name: 'uplnk-file-browse',
      command: serverCmd,
      args: [fileBrowseScript],
    });

    if (this.config.commandExecEnabled) {
      const cmdExecScript = join(__mcpDir, 'servers', `command-exec.${serverExt}`);
      await this.connect({
        id: BUILTIN_COMMAND_EXEC_ID,
        name: 'uplnk-command-exec',
        command: serverCmd,
        args: [cmdExecScript],
      });
    }

    if (this.config.gitEnabled) {
      const gitScript = join(__mcpDir, 'servers', `git.${serverExt}`);
      await this.connect({
        id: BUILTIN_GIT_ID,
        name: 'uplnk-git',
        command: serverCmd,
        args: [gitScript],
      });
    }

    if (this.config.ragEnabled) {
      const ragScript = join(__mcpDir, 'servers', `rag.${serverExt}`);
      const ragEnv: Record<string, string> = {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: process.env['HOME'] ?? '/tmp',
      };
      if (this.config.ragEmbedConfig !== undefined) {
        ragEnv['UPLNK_EMBED_BASE_URL'] = this.config.ragEmbedConfig.baseUrl;
        ragEnv['UPLNK_EMBED_API_KEY'] = this.config.ragEmbedConfig.apiKey;
        ragEnv['UPLNK_EMBED_MODEL'] = this.config.ragEmbedConfig.model;
      }
      await this.connect({
        id: BUILTIN_RAG_ID,
        name: 'uplnk-rag',
        command: serverCmd,
        args: [ragScript],
        env: ragEnv,
      });
    }
  }

  // ─── Tool registry ──────────────────────────────────────────────────────────

  /**
   * Returns an empty map — built-in tools are now in child processes and only
   * available after connectBuiltins() resolves (via getAiSdkToolsAsync()).
   *
   * Kept for API compat with useMcp.ts initial seed call. The empty map is
   * intentional: the LLM briefly has no tools until the child processes start.
   * In practice (~50 ms on a warm OS) this window is imperceptible.
   */
  getAiSdkTools(): Record<string, Tool> {
    return {};
  }

  /**
   * Async: fetches tools from all connected servers (built-ins + user-configured).
   * Built-in server tools are wrapped with pre-call security validation so all
   * path/command enforcement runs in this parent process (ADR-004).
   *
   * Call after connectBuiltins() + user-configured connect() calls have resolved.
   */
  async getAiSdkToolsAsync(): Promise<Record<string, Tool>> {
    const tools: Record<string, Tool> = {};
    const connectedIds = [...this.connections.entries()]
      .filter(([, c]) => c.status === 'connected')
      .map(([id]) => id);

    const remoteResults = await Promise.allSettled(
      connectedIds.map((id) => this.getRemoteToolsWithSecurity(id)),
    );

    for (const result of remoteResults) {
      if (result.status === 'fulfilled') {
        Object.assign(tools, result.value);
      }
    }

    return tools;
  }

  /**
   * Fetches tools from a server and applies security wrappers for built-in
   * servers. For user-configured servers, tools are returned unwrapped.
   *
   * Security decision (ADR-004): validation runs in the parent, not the child.
   * The child process (file-browse.ts / command-exec.ts) receives only
   * pre-validated calls — it performs no access control of its own.
   */
  private async getRemoteToolsWithSecurity(serverId: string): Promise<Record<string, Tool>> {
    const rawTools = await this.getRemoteTools(serverId);

    if (serverId === BUILTIN_FILE_BROWSE_ID) {
      return this.wrapFileBrowseTools(rawTools);
    }

    if (serverId === BUILTIN_COMMAND_EXEC_ID) {
      return this.wrapCommandExecTools(rawTools);
    }

    if (serverId === BUILTIN_GIT_ID) {
      return this.wrapGitTools(rawTools);
    }

    if (serverId === BUILTIN_RAG_ID) {
      return this.wrapRagTools(rawTools);
    }

    // User-configured external servers: no security wrapping (they have their own)
    return rawTools;
  }

  // ─── Security wrappers for built-in server tools ─────────────────────────────

  /**
   * Wraps mcp_file_read, mcp_file_list, mcp_file_write, and mcp_file_patch
   * tools from the file-browse child with pre-call path validation, content
   * size checking, the approval gate for write operations, and audit logging.
   */
  private wrapFileBrowseTools(rawTools: Record<string, Tool>): Record<string, Tool> {
    const policy = this.config.filePolicy;
    const { requestApproval, conversationId } = this.config;
    const logEntry = this.logToolCall.bind(this);
    const wrapped: Record<string, Tool> = {};

    if ('mcp_file_read' in rawTools) {
      const inner = rawTools['mcp_file_read']!;
      wrapped['mcp_file_read'] = {
        ...inner,
        execute: async (args: Record<string, unknown>, execOptions: Parameters<NonNullable<Tool['execute']>>[1]) => {
          const path = args['path'] as string;
          const validation = validateFilePath(path, policy);
          if (!validation.allowed) {
            logEntry({ ts: new Date().toISOString(), tool: 'mcp_file_read', args: { path }, outcome: 'denied', detail: validation.reason, ...(conversationId !== undefined ? { conversationId } : {}) });
            throw new Error(`MCP_TOOL_DENIED: ${validation.reason}`);
          }
          const { resolvedPath } = validation;
          const sizeResult = validateFileSize(resolvedPath, policy);
          if (!sizeResult.allowed) {
            logEntry({ ts: new Date().toISOString(), tool: 'mcp_file_read', args: { path, resolvedPath }, outcome: 'denied', detail: sizeResult.reason, ...(conversationId !== undefined ? { conversationId } : {}) });
            throw new Error(`MCP_TOOL_DENIED: ${sizeResult.reason}`);
          }
          logEntry({ ts: new Date().toISOString(), tool: 'mcp_file_read', args: { path, resolvedPath }, outcome: 'allowed', ...(conversationId !== undefined ? { conversationId } : {}) });
          return inner.execute!({ ...args, path: resolvedPath }, execOptions);
        },
      };
    }

    if ('mcp_file_list' in rawTools) {
      const inner = rawTools['mcp_file_list']!;
      wrapped['mcp_file_list'] = {
        ...inner,
        execute: async (args: Record<string, unknown>, execOptions: Parameters<NonNullable<Tool['execute']>>[1]) => {
          const path = args['path'] as string;
          const validation = validateFilePath(path, policy);
          if (!validation.allowed) {
            logEntry({ ts: new Date().toISOString(), tool: 'mcp_file_list', args: { path }, outcome: 'denied', detail: validation.reason, ...(conversationId !== undefined ? { conversationId } : {}) });
            throw new Error(`MCP_TOOL_DENIED: ${validation.reason}`);
          }
          const { resolvedPath } = validation;
          logEntry({ ts: new Date().toISOString(), tool: 'mcp_file_list', args: { path, resolvedPath }, outcome: 'allowed', ...(conversationId !== undefined ? { conversationId } : {}) });
          return inner.execute!({ ...args, path: resolvedPath }, execOptions);
        },
      };
    }

    if ('mcp_file_write' in rawTools) {
      const inner = rawTools['mcp_file_write']!;
      wrapped['mcp_file_write'] = {
        ...inner,
        execute: async (args: Record<string, unknown>, execOptions: Parameters<NonNullable<Tool['execute']>>[1]) => {
          const path = args['path'] as string;
          const content = args['content'] as string;

          // Layer 1: path validation
          const validation = validateFilePath(path, policy);
          if (!validation.allowed) {
            logEntry({ ts: new Date().toISOString(), tool: 'mcp_file_write', args: { path }, outcome: 'denied', detail: validation.reason, ...(conversationId !== undefined ? { conversationId } : {}) });
            throw new Error(`MCP_TOOL_DENIED: ${validation.reason}`);
          }
          const { resolvedPath } = validation;

          // Layer 1b: content size check (512 KiB)
          const MAX_WRITE_BYTES = 512 * 1024;
          const byteLength = Buffer.byteLength(content, 'utf-8');
          if (byteLength > MAX_WRITE_BYTES) {
            const kb = (byteLength / 1024).toFixed(1);
            const detail = `Content too large: ${kb} KiB (limit: 512 KiB).`;
            logEntry({ ts: new Date().toISOString(), tool: 'mcp_file_write', args: { path, resolvedPath, byteLength }, outcome: 'denied', detail, ...(conversationId !== undefined ? { conversationId } : {}) });
            throw new Error(`MCP_TOOL_DENIED: ${detail}`);
          }

          // Layer 2: human-in-the-loop approval gate
          const approvalId = crypto.randomUUID();
          const approved = await requestApproval({
            id: approvalId,
            command: 'file_write',
            args: [resolvedPath],
            ...(args['description'] !== undefined ? { description: args['description'] as string } : {}),
          });

          if (!approved) {
            logEntry({ ts: new Date().toISOString(), tool: 'mcp_file_write', args: { path, resolvedPath, byteLength, approvalId }, outcome: 'denied', detail: 'User denied at approval gate.', ...(conversationId !== undefined ? { conversationId } : {}) });
            throw new Error('MCP_TOOL_DENIED: User denied file write.');
          }

          logEntry({ ts: new Date().toISOString(), tool: 'mcp_file_write', args: { path, resolvedPath, byteLength, approvalId }, outcome: 'allowed', ...(conversationId !== undefined ? { conversationId } : {}) });
          return inner.execute!({ ...args, path: resolvedPath }, execOptions);
        },
      };
    }

    if ('mcp_file_patch' in rawTools) {
      const inner = rawTools['mcp_file_patch']!;
      wrapped['mcp_file_patch'] = {
        ...inner,
        execute: async (args: Record<string, unknown>, execOptions: Parameters<NonNullable<Tool['execute']>>[1]) => {
          const path = args['path'] as string;

          // Layer 1: path validation
          const validation = validateFilePath(path, policy);
          if (!validation.allowed) {
            logEntry({ ts: new Date().toISOString(), tool: 'mcp_file_patch', args: { path }, outcome: 'denied', detail: validation.reason, ...(conversationId !== undefined ? { conversationId } : {}) });
            throw new Error(`MCP_TOOL_DENIED: ${validation.reason}`);
          }
          const { resolvedPath } = validation;

          // Layer 2: human-in-the-loop approval gate
          const approvalId = crypto.randomUUID();
          const approved = await requestApproval({
            id: approvalId,
            command: 'file_patch',
            args: [resolvedPath],
            ...(args['description'] !== undefined ? { description: args['description'] as string } : {}),
          });

          if (!approved) {
            logEntry({ ts: new Date().toISOString(), tool: 'mcp_file_patch', args: { path, resolvedPath, approvalId }, outcome: 'denied', detail: 'User denied at approval gate.', ...(conversationId !== undefined ? { conversationId } : {}) });
            throw new Error('MCP_TOOL_DENIED: User denied file patch.');
          }

          logEntry({ ts: new Date().toISOString(), tool: 'mcp_file_patch', args: { path, resolvedPath, approvalId }, outcome: 'allowed', ...(conversationId !== undefined ? { conversationId } : {}) });
          return inner.execute!({ ...args, path: resolvedPath }, execOptions);
        },
      };
    }

    return wrapped;
  }

  /**
   * Wraps mcp_command_exec from the command-exec child with pre-call structural
   * validation and the human-in-the-loop approval gate.
   */
  private wrapCommandExecTools(rawTools: Record<string, Tool>): Record<string, Tool> {
    const policy = this.config.filePolicy;
    const { requestApproval, conversationId } = this.config;
    const logEntry = this.logToolCall.bind(this);
    const wrapped: Record<string, Tool> = {};

    if ('mcp_command_exec' in rawTools) {
      const inner = rawTools['mcp_command_exec']!;
      wrapped['mcp_command_exec'] = {
        ...inner,
        execute: async (args: Record<string, unknown>, execOptions: Parameters<NonNullable<Tool['execute']>>[1]) => {
          const command = args['command'] as string;
          const cmdArgs = (args['args'] as string[] | undefined) ?? [];
          const cwd = args['cwd'] as string | undefined;
          const description = args['description'] as string | undefined;

          // Layer 1: structural validation
          const validation = validateCommand({ command, args: cmdArgs, ...(cwd !== undefined ? { cwd } : {}) }, policy);
          if (!validation.allowed) {
            logEntry({ ts: new Date().toISOString(), tool: 'mcp_command_exec', args: { command, argCount: cmdArgs.length, cwd }, outcome: 'denied', detail: validation.reason, ...(conversationId !== undefined ? { conversationId } : {}) });
            throw new Error(`MCP_TOOL_DENIED: ${validation.reason}`);
          }

          // Layer 2: human-in-the-loop approval
          const approvalId = crypto.randomUUID();
          const approved = await requestApproval({
            id: approvalId,
            command,
            args: cmdArgs,
            ...(cwd !== undefined ? { cwd } : {}),
            ...(description !== undefined ? { description } : {}),
          });

          if (!approved) {
            logEntry({ ts: new Date().toISOString(), tool: 'mcp_command_exec', args: { command, argCount: cmdArgs.length, cwd, approvalId }, outcome: 'denied', detail: 'User denied at approval gate.', ...(conversationId !== undefined ? { conversationId } : {}) });
            throw new Error('MCP_TOOL_DENIED: User denied command execution.');
          }

          logEntry({ ts: new Date().toISOString(), tool: 'mcp_command_exec', args: { command, argCount: cmdArgs.length, cwd, approvalId }, outcome: 'allowed', ...(conversationId !== undefined ? { conversationId } : {}) });
          return inner.execute!(args, execOptions);
        },
      };
    }

    return wrapped;
  }

  /**
   * Wraps git tools from the uplnk-git child process with pre-call repoPath
   * validation and the human-in-the-loop approval gate for mutating operations
   * (mcp_git_stage and mcp_git_commit).
   *
   * mcp_git_status and mcp_git_diff are read-only — they forward without approval.
   * All four tools validate repoPath (when provided) against the file policy.
   */
  private wrapGitTools(rawTools: Record<string, Tool>): Record<string, Tool> {
    const policy = this.config.filePolicy;
    const { requestApproval, conversationId } = this.config;
    const logEntry = this.logToolCall.bind(this);
    const wrapped: Record<string, Tool> = {};

    /** Shared repoPath validation — returns resolvedPath or throws. */
    function validateRepoPath(
      repoPath: string | undefined,
      toolName: string,
    ): string | undefined {
      if (repoPath === undefined) return undefined;
      const validation = validateFilePath(repoPath, policy);
      if (!validation.allowed) {
        logEntry({
          ts: new Date().toISOString(),
          tool: toolName,
          args: { repoPath },
          outcome: 'denied',
          detail: validation.reason,
          ...(conversationId !== undefined ? { conversationId } : {}),
        });
        throw new Error(`MCP_TOOL_DENIED: ${validation.reason}`);
      }
      return validation.resolvedPath;
    }

    // ─── mcp_git_status (read-only, no approval needed) ──────────────────────

    if ('mcp_git_status' in rawTools) {
      const inner = rawTools['mcp_git_status']!;
      wrapped['mcp_git_status'] = {
        ...inner,
        execute: async (args: Record<string, unknown>, execOptions: Parameters<NonNullable<Tool['execute']>>[1]) => {
          const repoPath = args['repoPath'] as string | undefined;
          const resolvedRepo = validateRepoPath(repoPath, 'mcp_git_status');
          logEntry({
            ts: new Date().toISOString(),
            tool: 'mcp_git_status',
            args: { repoPath: resolvedRepo ?? '(cwd)' },
            outcome: 'allowed',
            ...(conversationId !== undefined ? { conversationId } : {}),
          });
          return inner.execute!(
            { ...args, ...(resolvedRepo !== undefined ? { repoPath: resolvedRepo } : {}) },
            execOptions,
          );
        },
      };
    }

    // ─── mcp_git_diff (read-only, no approval needed) ────────────────────────

    if ('mcp_git_diff' in rawTools) {
      const inner = rawTools['mcp_git_diff']!;
      wrapped['mcp_git_diff'] = {
        ...inner,
        execute: async (args: Record<string, unknown>, execOptions: Parameters<NonNullable<Tool['execute']>>[1]) => {
          const repoPath = args['repoPath'] as string | undefined;
          const resolvedRepo = validateRepoPath(repoPath, 'mcp_git_diff');
          logEntry({
            ts: new Date().toISOString(),
            tool: 'mcp_git_diff',
            args: { repoPath: resolvedRepo ?? '(cwd)', staged: args['staged'], filePath: args['filePath'] },
            outcome: 'allowed',
            ...(conversationId !== undefined ? { conversationId } : {}),
          });
          return inner.execute!(
            { ...args, ...(resolvedRepo !== undefined ? { repoPath: resolvedRepo } : {}) },
            execOptions,
          );
        },
      };
    }

    // ─── mcp_git_stage (mutating — requires approval) ────────────────────────

    if ('mcp_git_stage' in rawTools) {
      const inner = rawTools['mcp_git_stage']!;
      wrapped['mcp_git_stage'] = {
        ...inner,
        execute: async (args: Record<string, unknown>, execOptions: Parameters<NonNullable<Tool['execute']>>[1]) => {
          const repoPath = args['repoPath'] as string | undefined;
          const paths = args['paths'] as string[];
          const resolvedRepo = validateRepoPath(repoPath, 'mcp_git_stage');

          const approvalId = crypto.randomUUID();
          const approved = await requestApproval({
            id: approvalId,
            command: 'git_stage',
            args: paths,
            ...(resolvedRepo !== undefined ? { cwd: resolvedRepo } : {}),
            description: `Stage ${paths.length} file${paths.length !== 1 ? 's' : ''} for commit`,
          });

          if (!approved) {
            logEntry({
              ts: new Date().toISOString(),
              tool: 'mcp_git_stage',
              args: { repoPath: resolvedRepo ?? '(cwd)', pathCount: paths.length, approvalId },
              outcome: 'denied',
              detail: 'User denied at approval gate.',
              ...(conversationId !== undefined ? { conversationId } : {}),
            });
            throw new Error('MCP_TOOL_DENIED: User denied git stage.');
          }

          logEntry({
            ts: new Date().toISOString(),
            tool: 'mcp_git_stage',
            args: { repoPath: resolvedRepo ?? '(cwd)', pathCount: paths.length, approvalId },
            outcome: 'allowed',
            ...(conversationId !== undefined ? { conversationId } : {}),
          });
          return inner.execute!(
            { ...args, ...(resolvedRepo !== undefined ? { repoPath: resolvedRepo } : {}) },
            execOptions,
          );
        },
      };
    }

    // ─── mcp_git_commit (mutating — requires approval) ───────────────────────

    if ('mcp_git_commit' in rawTools) {
      const inner = rawTools['mcp_git_commit']!;
      wrapped['mcp_git_commit'] = {
        ...inner,
        execute: async (args: Record<string, unknown>, execOptions: Parameters<NonNullable<Tool['execute']>>[1]) => {
          const repoPath = args['repoPath'] as string | undefined;
          const message = args['message'] as string;
          const resolvedRepo = validateRepoPath(repoPath, 'mcp_git_commit');

          const approvalId = crypto.randomUUID();
          const approved = await requestApproval({
            id: approvalId,
            command: 'git_commit',
            args: [message],
            ...(resolvedRepo !== undefined ? { cwd: resolvedRepo } : {}),
            description: `Create commit: ${message}`,
          });

          if (!approved) {
            logEntry({
              ts: new Date().toISOString(),
              tool: 'mcp_git_commit',
              args: { repoPath: resolvedRepo ?? '(cwd)', approvalId },
              outcome: 'denied',
              detail: 'User denied at approval gate.',
              ...(conversationId !== undefined ? { conversationId } : {}),
            });
            throw new Error('MCP_TOOL_DENIED: User denied git commit.');
          }

          logEntry({
            ts: new Date().toISOString(),
            tool: 'mcp_git_commit',
            args: { repoPath: resolvedRepo ?? '(cwd)', approvalId },
            outcome: 'allowed',
            ...(conversationId !== undefined ? { conversationId } : {}),
          });
          return inner.execute!(
            { ...args, ...(resolvedRepo !== undefined ? { repoPath: resolvedRepo } : {}) },
            execOptions,
          );
        },
      };
    }

    return wrapped;
  }

  /**
   * Wraps RAG tools from the uplnk-rag child process with pre-call security.
   *
   * mcp_rag_search — read-only; no path validation needed (operates on the DB
   *   which was populated from already-validated indexed paths). Audited.
   *
   * mcp_rag_index — validates that the target directory is within allowedRoots
   *   before forwarding. No approval gate (indexing is read-only on the FS
   *   and only writes to the local DB — not a destructive operation).
   */
  private wrapRagTools(rawTools: Record<string, Tool>): Record<string, Tool> {
    const policy = this.config.filePolicy;
    const { conversationId } = this.config;
    const logEntry = this.logToolCall.bind(this);
    const wrapped: Record<string, Tool> = {};

    // ─── mcp_rag_search (read-only, no path validation needed) ───────────────

    if ('mcp_rag_search' in rawTools) {
      const inner = rawTools['mcp_rag_search']!;
      wrapped['mcp_rag_search'] = {
        ...inner,
        execute: async (args: Record<string, unknown>, execOptions: Parameters<NonNullable<Tool['execute']>>[1]) => {
          const query = args['query'] as string;
          logEntry({
            ts: new Date().toISOString(),
            tool: 'mcp_rag_search',
            args: { queryLength: query?.length ?? 0 },
            outcome: 'allowed',
            ...(conversationId !== undefined ? { conversationId } : {}),
          });
          return inner.execute!(args, execOptions);
        },
      };
    }

    // ─── mcp_rag_index (validates directory against allowedRoots) ────────────

    if ('mcp_rag_index' in rawTools) {
      const inner = rawTools['mcp_rag_index']!;
      wrapped['mcp_rag_index'] = {
        ...inner,
        execute: async (args: Record<string, unknown>, execOptions: Parameters<NonNullable<Tool['execute']>>[1]) => {
          const directory = args['directory'] as string;

          // Validate target directory is within allowed roots
          const validation = validateFilePath(directory, policy);
          if (!validation.allowed) {
            logEntry({
              ts: new Date().toISOString(),
              tool: 'mcp_rag_index',
              args: { directory },
              outcome: 'denied',
              detail: validation.reason,
              ...(conversationId !== undefined ? { conversationId } : {}),
            });
            throw new Error(`MCP_TOOL_DENIED: ${validation.reason}`);
          }

          const resolvedDir = validation.resolvedPath;
          logEntry({
            ts: new Date().toISOString(),
            tool: 'mcp_rag_index',
            args: { directory, resolvedDir },
            outcome: 'allowed',
            ...(conversationId !== undefined ? { conversationId } : {}),
          });
          return inner.execute!({ ...args, directory: resolvedDir }, execOptions);
        },
      };
    }

    return wrapped;
  }

  // ─── Built-in tools (REMOVED — now in child processes) ──────────────────────
  // buildFileReadTool(), buildFileListTool(), buildCommandExecTool() were deleted
  // as part of arch-critical-fixes Phase 4 (ADR-004). The child process servers
  // at src/lib/mcp/servers/{file-browse,command-exec}.ts now handle execution.
  // Security wrappers above enforce path validation and approval before forwarding.

  // ─── Status ─────────────────────────────────────────────────────────────────

  getConnectionStatus(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [id, conn] of this.connections) {
      result[id] = conn.status;
    }
    return result;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalize a callTool() response from the MCP SDK into a plain string.
 * The MCP spec returns content as an array of typed blocks (text, image, etc.).
 * We concatenate all text blocks; non-text blocks are represented as
 * "[<type> content]" placeholders so the LLM context remains complete.
 */
function normalizeMcpToolResult(
  result: Awaited<ReturnType<Client['callTool']>>,
): string {
  if (!Array.isArray(result.content) || result.content.length === 0) {
    return result.isError === true ? '[tool returned an error]' : '(no output)';
  }

  return result.content
    .map((block) => {
      if (block.type === 'text') {
        return typeof block.text === 'string' ? block.text : '';
      }
      // image, resource, etc. — surface as placeholder
      return `[${block.type} content]`;
    })
    .filter(Boolean)
    .join('\n');
}
