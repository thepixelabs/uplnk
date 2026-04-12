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
import { getPylonDir } from 'uplnk-db';

// ─── Built-in server resolution ──────────────────────────────────────────────

const __mcpDir = dirname(fileURLToPath(import.meta.url));
// Detect dev mode (tsx running .ts files) vs. compiled mode (.js files).
const _isTsSource = import.meta.url.endsWith('.ts');
const _serverExt = _isTsSource ? 'ts' : 'js';
const _serverCmd = _isTsSource ? 'tsx' : process.execPath;

/** Sentinel IDs for the built-in child-process servers. */
export const BUILTIN_FILE_BROWSE_ID = '__pylon_builtin_file_browse__';
export const BUILTIN_COMMAND_EXEC_ID = '__pylon_builtin_command_exec__';
export const BUILTIN_GIT_ID = '__pylon_builtin_git__';
export const BUILTIN_RAG_ID = '__pylon_builtin_rag__';

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

// ─── McpManager ───────────────────────────────────────────────────────────────

export class McpManager {
  private readonly connections = new Map<string, ServerConnection>();
  private readonly config: McpManagerConfig;
  private destroyed = false;
  /** Resolved once at construction so all logToolCall() calls use the same path. */
  private readonly auditLogPath: string;

  constructor(config: McpManagerConfig) {
    this.config = config;
    const pylonDir = getPylonDir();
    // Ensure ~/.uplnk exists. Normally created by getOrCreateConfig() in config.ts,
    // but McpManager may be instantiated in test contexts before that runs.
    try {
      mkdirSync(pylonDir, { recursive: true });
    } catch {
      // If mkdir fails we proceed — logToolCall() swallows errors so the app
      // never crashes on audit log failures.
    }
    this.auditLogPath = join(pylonDir, 'mcp-audit.log');
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
   * across concurrent pylon processes sharing the same log file: worst
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
      const line = JSON.stringify(entry) + '\n';
      appendFileSync(this.auditLogPath, line, { encoding: 'utf-8', flag: 'a' });
    } catch (err) {
      // Never let an audit failure crash the app or block execution.
      process.stderr.write(
        `[pylon audit] WARNING: failed to write audit log entry: ${String(err)}\n`,
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

    const transportType = serverConfig.type ?? 'stdio';
    let transport: StdioClientTransport | StreamableHTTPClientTransport;

    if (transportType === 'http') {
      if (serverConfig.url === undefined) {
        throw new Error(`MCP server "${serverConfig.id}" has type "http" but no url`);
      }
      transport = new StreamableHTTPClientTransport(new URL(serverConfig.url));
    } else {
      if (serverConfig.command === undefined) {
        throw new Error(`MCP server "${serverConfig.id}" has type "stdio" but no command`);
      }
      transport = new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args ?? [],
        ...(serverConfig.env !== undefined ? { env: serverConfig.env } : {}),
      });
    }

    const client = new Client(
      { name: 'pylon', version: '0.1.0' },
      { capabilities: {} },
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
    transport.onclose = () => {
      const existing = this.connections.get(serverConfig.id);
      if (existing !== undefined) {
        existing.status = 'closed';
        this.connections.delete(serverConfig.id);
      }
    };

    transport.onerror = (err: Error) => {
      const existing = this.connections.get(serverConfig.id);
      if (existing !== undefined) {
        existing.status = 'error';
        existing.error = err;
        this.connections.delete(serverConfig.id);
      }
    };

    try {
      // exactOptionalPropertyTypes: StreamableHTTPClientTransport.sessionId is
      // typed string|undefined in the SDK but Transport requires string. Both
      // transports satisfy the runtime Transport contract — cast to suppress.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await client.connect(transport as any);
      conn.status = 'connected';
    } catch (err) {
      conn.status = 'error';
      conn.error = err instanceof Error ? err : new Error(String(err));
      this.connections.delete(serverConfig.id);
      throw conn.error;
    }
  }

  async disconnect(serverId: string): Promise<void> {
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
    this.destroyed = true;
    const ids = [...this.connections.keys()];
    await Promise.allSettled(ids.map((id) => this.disconnect(id)));
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

    for (const mcpTool of toolsResult.tools) {
      const toolName = mcpTool.name;
      const inputSchema = mcpTool.inputSchema as Record<string, unknown>;
      const client = conn.client;

      tools[toolName] = {
        description: mcpTool.description ?? toolName,
        // jsonSchema() from 'ai' accepts a raw JSON Schema object — no Zod needed
        // for remote tools since we receive the schema from the server at runtime.
        parameters: jsonSchema(inputSchema as Parameters<typeof jsonSchema>[0]),
        execute: async (args: Record<string, unknown>): Promise<string> => {
          const result = await client.callTool({ name: toolName, arguments: args });
          return normalizeMcpToolResult(result);
        },
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
    const fileBrowseScript = join(__mcpDir, 'servers', `file-browse.${_serverExt}`);
    await this.connect({
      id: BUILTIN_FILE_BROWSE_ID,
      name: 'pylon-file-browse',
      command: _serverCmd,
      args: [fileBrowseScript],
    });

    if (this.config.commandExecEnabled) {
      const cmdExecScript = join(__mcpDir, 'servers', `command-exec.${_serverExt}`);
      await this.connect({
        id: BUILTIN_COMMAND_EXEC_ID,
        name: 'pylon-command-exec',
        command: _serverCmd,
        args: [cmdExecScript],
      });
    }

    if (this.config.gitEnabled) {
      const gitScript = join(__mcpDir, 'servers', `git.${_serverExt}`);
      await this.connect({
        id: BUILTIN_GIT_ID,
        name: 'pylon-git',
        command: _serverCmd,
        args: [gitScript],
      });
    }

    if (this.config.ragEnabled) {
      const ragScript = join(__mcpDir, 'servers', `rag.${_serverExt}`);
      const ragEnv: Record<string, string> = {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: process.env['HOME'] ?? '/tmp',
      };
      if (this.config.ragEmbedConfig !== undefined) {
        ragEnv['PYLON_EMBED_BASE_URL'] = this.config.ragEmbedConfig.baseUrl;
        ragEnv['PYLON_EMBED_API_KEY'] = this.config.ragEmbedConfig.apiKey;
        ragEnv['PYLON_EMBED_MODEL'] = this.config.ragEmbedConfig.model;
      }
      await this.connect({
        id: BUILTIN_RAG_ID,
        name: 'pylon-rag',
        command: _serverCmd,
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
   * Wraps git tools from the pylon-git child process with pre-call repoPath
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
   * Wraps RAG tools from the pylon-rag child process with pre-call security.
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
