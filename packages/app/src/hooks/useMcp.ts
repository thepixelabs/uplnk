/**
 * useMcp — React hook that manages the MCP manager lifecycle and provides:
 * - AI SDK tool definitions to pass into useStream / streamText
 * - Pending approval requests for the ApprovalDialog
 * - A callback to resolve approval requests (Y/N)
 *
 * Gap 1: On mount, loads .mcp.json from the repo root, calls manager.connect()
 * for each server, then refreshes the tool set via getAiSdkToolsAsync() which
 * calls listTools() on every connected server and bridges results to AI SDK
 * Tool objects using jsonSchema() from 'ai'.
 *
 * Gap 4: mcpTools is stabilised with useMemo so its object identity only
 * changes when the tools map actually changes — prevents useStream from
 * receiving a new reference on every render.
 *
 * The McpManager instance is created once and torn down on unmount.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpManager } from '../lib/mcp/McpManager.js';
import { createDefaultPolicy } from '../lib/mcp/security.js';
import { loadPluginConfigs } from '../lib/plugins/loader.js';
import type { McpServerConfig } from '../lib/mcp/McpManager.js';
import type { ApprovalRequest } from '../components/mcp/ApprovalDialog.js';
import type { Tool } from 'ai';

// ─── Rate limiting ────────────────────────────────────────────────────────────

/**
 *: Maximum number of MCP tool calls allowed per conversation.
 * Prevents runaway LLM loops from issuing unbounded tool calls in a single session.
 */
export const MAX_TOOL_CALLS_PER_CONVERSATION = 100;

// ─── .mcp.json schema ─────────────────────────────────────────────────────────

/**
 * The shape of .mcp.json at repo root.
 * Supports both stdio (command-based) and http (URL-based) servers.
 *
 * Example:
 * {
 *   "mcpServers": {
 *     "dispatch": { "type": "http", "url": "http://localhost:4242/mcp" },
 *     "files":    { "type": "stdio", "command": "npx", "args": ["-y", "@uplnk/mcp-files"] }
 *   }
 * }
 */
interface McpJsonEntry {
  type?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

interface McpJson {
  mcpServers?: Record<string, McpJsonEntry>;
}

function loadMcpJson(repoRoot: string): McpServerConfig[] {
  const mcpJsonPath = join(repoRoot, '.mcp.json');
  try {
    const raw = readFileSync(mcpJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as McpJson;
    const servers = parsed.mcpServers;
    if (servers === undefined || typeof servers !== 'object') return [];

    return Object.entries(servers).map(([id, entry]) => ({
      id,
      name: id,
      ...(entry.type !== undefined ? { type: entry.type } : {}),
      ...(entry.command !== undefined ? { command: entry.command } : {}),
      ...(entry.args !== undefined ? { args: entry.args } : {}),
      ...(entry.env !== undefined ? { env: entry.env } : {}),
      ...(entry.url !== undefined ? { url: entry.url } : {}),
    }));
  } catch {
    // .mcp.json missing or malformed — silently skip external servers
    return [];
  }
}

/**
 * Merge MCP server lists from three user sources: config.json (team-wide),
 * installed plugins (community), and .mcp.json (project-local). Last write
 * wins on id collision, so the precedence chain is:
 *
 *     config.json  <  plugins  <  .mcp.json
 *
 * Project-local `.mcp.json` is the highest-precedence source because a
 * project maintainer's explicit config must always win over a globally
 * installed plugin with the same id (otherwise a rogue plugin could shadow
 * a project's intended server). Plugins in turn override team-wide
 * config.json so a user opting in to a plugin gets the plugin's version.
 *
 * Built-in ids (`__uplnk_builtin_*`) are hard-rejected from ALL sources.
 */
export function mergeMcpConfigs(
  fromConfig: McpServerConfig[],
  fromMcpJson: McpServerConfig[],
  fromPlugins: McpServerConfig[],
): { configs: McpServerConfig[]; warnings: string[] } {
  const byId = new Map<string, McpServerConfig>();
  const warnings: string[] = [];
  const sources: Array<{ label: string; list: McpServerConfig[] }> = [
    { label: 'config.json', list: fromConfig },
    { label: 'plugin', list: fromPlugins },
    { label: '.mcp.json', list: fromMcpJson },
  ];
  for (const { label, list } of sources) {
    for (const cfg of list) {
      if (cfg.id.startsWith('__uplnk_builtin_')) {
        warnings.push(`[mcp] ${label} server '${cfg.id}' uses a reserved builtin id — skipped`);
        continue;
      }
      if (byId.has(cfg.id)) {
        warnings.push(`[mcp] duplicate server id '${cfg.id}' — ${label} overrides earlier source`);
      }
      byId.set(cfg.id, cfg);
    }
  }
  return { configs: Array.from(byId.values()), warnings };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

interface UseMcpOptions {
  allowedPaths: string[];
  commandExecEnabled: boolean;
  /**
   *: commandExecEnabled is only honoured when this is a
   * valid ISO timestamp set by `uplnk config --confirm-command-exec`.
   * When absent, command execution is disabled regardless of the flag value.
   */
  commandExecConfirmedAt?: string;
  /** Whether the git integration tools are enabled. Default: true. */
  gitEnabled: boolean;
  /** Whether RAG tools (semantic search + indexing) are enabled. Default: false. */
  ragEnabled: boolean;
  /** Optional embedding config for the RAG server. */
  ragEmbedConfig?: {
    baseUrl: string;
    apiKey: string;
    model: string;
  } | undefined;
  /** Repo root directory used to locate .mcp.json. Defaults to process.cwd(). */
  repoRoot?: string;
  /**
   *: Current conversation ID — used to reset the per-
   * conversation tool call counter when a new conversation starts.
   */
  conversationId?: string;
  /**
   * User-configured MCP servers from `config.mcp.servers`. Merged with
   * `.mcp.json` (project-local) and installed plugins before connecting.
   */
  configServers?: McpServerConfig[];
}

export interface UseMcpResult {
  tools: Record<string, Tool>;
  pendingApproval: ApprovalRequest | null;
  resolveApproval: (id: string, approved: boolean) => void;
}

export function useMcp({
  allowedPaths,
  commandExecEnabled,
  commandExecConfirmedAt,
  gitEnabled,
  ragEnabled,
  ragEmbedConfig,
  repoRoot = process.cwd(),
  conversationId,
  configServers = [],
}: UseMcpOptions): UseMcpResult {
  //: command execution requires BOTH the feature flag AND
  // an explicit interactive confirmation timestamp. A config file dropped
  // silently (e.g. by a postinstall script) cannot enable command execution.
  const isCommandExecConfirmed =
    commandExecEnabled === true &&
    commandExecConfirmedAt !== undefined &&
    commandExecConfirmedAt.trim() !== '' &&
    !isNaN(Date.parse(commandExecConfirmedAt));

  const effectiveCommandExecEnabled = isCommandExecConfirmed;
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  // Gap 4: store tool map in state so useMemo can key off it; object identity
  // only changes when a new async tool enumeration completes.
  const [toolMap, setToolMap] = useState<Record<string, Tool>>({});

  //: per-conversation tool call counter. Starts at 0 on mount
  // and is reset whenever the conversationId prop changes (new conversation).
  // In-memory only — intentionally not persisted to the DB.
  const toolCallCountRef = useRef<number>(0);

  // Map from approval id → resolve function (called from inside the tool execute callback)
  const pendingResolversRef = useRef<Map<string, (approved: boolean) => void>>(new Map());

  const requestApproval = useCallback(
    (request: ApprovalRequest): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        pendingResolversRef.current.set(request.id, resolve);
        setPendingApproval(request);
      });
    },
    [],
  );

  const resolveApproval = useCallback((id: string, approved: boolean) => {
    const resolver = pendingResolversRef.current.get(id);
    if (resolver !== undefined) {
      pendingResolversRef.current.delete(id);
      setPendingApproval(null);
      resolver(approved);
    }
  }, []);

  // Effective allowed paths: use CWD as fallback when none configured.
  // Keyed on a joined string so the memo is stable even when the caller
  // re-creates the array reference on every render (e.g. inline literals).
  const allowedPathsKey = allowedPaths.join('|');
  const effectivePaths = useMemo(
    () => (allowedPaths.length > 0 ? allowedPaths : [process.cwd()]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allowedPathsKey],
  );

  // createDefaultPolicy calls realpathSync on every path — memoize so we
  // never touch the filesystem more than once per unique set of allowed paths.
  const filePolicy = useMemo(
    () => createDefaultPolicy(effectivePaths),
    [effectivePaths],
  );

  const managerRef = useRef<McpManager | null>(null);
  if (managerRef.current === null) {
    managerRef.current = new McpManager({
      filePolicy,
      commandExecEnabled: effectiveCommandExecEnabled,
      gitEnabled,
      ragEnabled,
      ...(ragEmbedConfig !== undefined ? { ragEmbedConfig } : {}),
      requestApproval,
    });
  }

  // Gap 1: On mount, connect to all servers declared in .mcp.json and then
  // enumerate their tools. Update toolMap state when async enumeration resolves
  // so useMemo below picks up the final stable reference.
  useEffect(() => {
    const manager = managerRef.current;
    if (manager === null) return;

    let cancelled = false;

    async function connectAndLoadTools(): Promise<void> {
      if (manager === null) return;

      // Merge three user-owned MCP server sources: global config.json
      // `mcp.servers`, project-local `.mcp.json`, and installed plugins.
      // Built-ins are always connected in parallel. Merge collisions are
      // warned to stderr but not fatal — later sources override earlier.
      const fromMcpJson = loadMcpJson(repoRoot);
      let fromPlugins: McpServerConfig[] = [];
      try {
        fromPlugins = loadPluginConfigs();
      } catch {
        // Corrupted ~/.uplnk/plugins directory must not break MCP startup.
      }
      const merged = mergeMcpConfigs(configServers, fromMcpJson, fromPlugins);
      for (const warn of merged.warnings) {
        console.warn(warn);
      }

      await Promise.allSettled([
        manager.connectBuiltins().catch(() => undefined),
        ...merged.configs.map((cfg) => manager.connect(cfg).catch(() => undefined)),
      ]);

      if (cancelled) return;

      // Enumerate tools from all connected servers with security wrappers applied
      const fullTools = await manager.getAiSdkToolsAsync();
      if (!cancelled) setToolMap(fullTools);
    }

    void connectAndLoadTools();

    return () => {
      cancelled = true;
      void manager.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally run once on mount only

  //
  useEffect(() => {
    toolCallCountRef.current = 0;
  }, [conversationId]);

  // Gap 4: Stabilise the tools reference. useMemo returns the same object
  // identity until toolMap itself is replaced by setToolMap — callers like
  // useStream only re-render when the tool set actually changes.
  // with a rate-limit check so no single
  // conversation can issue more than MAX_TOOL_CALLS_PER_CONVERSATION calls.
  const tools = useMemo((): Record<string, Tool> => {
    const limited: Record<string, Tool> = {};
    for (const [name, tool] of Object.entries(toolMap)) {
      const originalExecute = tool.execute;
      if (originalExecute === undefined) {
        limited[name] = tool;
        continue;
      }
      limited[name] = {
        ...tool,
        execute: async (
          args: Parameters<NonNullable<Tool['execute']>>[0],
          options: Parameters<NonNullable<Tool['execute']>>[1],
        ): Promise<unknown> => {
          toolCallCountRef.current += 1;
          if (toolCallCountRef.current > MAX_TOOL_CALLS_PER_CONVERSATION) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `Tool call limit reached (${MAX_TOOL_CALLS_PER_CONVERSATION}/conversation). Start a new conversation.`,
                },
              ],
            };
          }
          return originalExecute(args, options);
        },
      };
    }
    return limited;
  }, [toolMap]);

  return { tools, pendingApproval, resolveApproval };
}
