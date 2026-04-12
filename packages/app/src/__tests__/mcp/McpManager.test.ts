/**
 * McpManager tests
 *
 * Architecture (post arch-critical-fixes Phase 4 / ADR-004):
 * - Built-in tools (mcp_file_read, mcp_file_list, mcp_command_exec) now live in
 *   child-process stdio MCP servers. McpManager spawns them via connectBuiltins()
 *   and wraps their tools with pre-call security validation.
 * - getAiSdkTools() returns {} (no synchronous built-ins).
 * - getAiSdkToolsAsync() returns tools after connectBuiltins() resolves.
 *
 * Strategy:
 * - Mock @modelcontextprotocol/sdk Client and StdioClientTransport at module
 *   boundary — these are owned by the MCP SDK, not by us.
 * - Mock node:fs for security validation calls (statSync for size checks).
 * - Never mock internal McpManager collaborators — only boundary modules.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';

// ─── SDK mocks (must precede all imports that transitively load the SDK) ──────

const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockListTools = vi.fn();
const mockCallTool = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: vi.fn().mockImplementation(() => ({
      connect: mockConnect,
      close: mockClose,
      listTools: mockListTools,
      callTool: mockCallTool,
    })),
  };
});

const mockTransportConstructor = vi.fn();
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: vi.fn().mockImplementation((opts: unknown) => {
      mockTransportConstructor(opts);
      return { _opts: opts };
    }),
  };
});

// ─── node:fs mock (for security validators that call statSync / realpathSync) ─

const mockStatSync = vi.fn();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: (...args: unknown[]) => mockStatSync(...args),
    realpathSync: (p: string) => p, // identity — no real FS in unit tests
    mkdirSync: vi.fn(),             // suppress ~/.uplnk mkdir in constructor
    appendFileSync: vi.fn(),        // suppress audit log writes in tests
  };
});

// ─── Subject under test (imported AFTER mocks are in place) ──────────────────

import { McpManager, BUILTIN_FILE_BROWSE_ID, BUILTIN_COMMAND_EXEC_ID, BUILTIN_GIT_ID } from '../../lib/mcp/McpManager.js';
import { createDefaultPolicy } from '../../lib/mcp/security.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from 'ai';

// ─── Test fixtures ────────────────────────────────────────────────────────────

const ALLOWED_ROOT = '/projects/myapp';

function makePolicy() {
  return createDefaultPolicy([ALLOWED_ROOT]);
}

function makeApproval(result = true) {
  return vi.fn().mockResolvedValue(result);
}

function makeManager({
  commandExecEnabled = false,
  gitEnabled = false,
  ragEnabled = false,
  approval = makeApproval(),
}: {
  commandExecEnabled?: boolean;
  gitEnabled?: boolean;
  ragEnabled?: boolean;
  approval?: ReturnType<typeof makeApproval>;
} = {}) {
  return new McpManager({
    filePolicy: makePolicy(),
    commandExecEnabled,
    gitEnabled,
    ragEnabled,
    requestApproval: approval,
  });
}

const SERVER_CONFIG = {
  id: 'test-server',
  name: 'Test Server',
  command: 'node',
  args: ['server.js'],
  env: { NODE_ENV: 'test' },
};

/** Minimal tool schema shapes returned by the built-in stdio servers. */
const FILE_BROWSE_TOOL_LIST = {
  tools: [
    {
      name: 'mcp_file_read',
      description: 'Read the UTF-8 contents of a file at the given path.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    {
      name: 'mcp_file_list',
      description: 'List files and directories at a path.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          recursive: { type: 'boolean' },
          maxDepth: { type: 'number' },
        },
        required: ['path'],
      },
    },
    {
      name: 'mcp_file_write',
      description: 'Write UTF-8 content to a file.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          createDirs: { type: 'boolean' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'mcp_file_patch',
      description: 'Apply a unified diff patch to a file.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          patch: { type: 'string' },
          dryRun: { type: 'boolean' },
        },
        required: ['path', 'patch'],
      },
    },
  ],
};

const COMMAND_EXEC_TOOL_LIST = {
  tools: [
    {
      name: 'mcp_command_exec',
      description: 'Execute a shell command.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          cwd: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['command'],
      },
    },
  ],
};

const GIT_TOOL_LIST = {
  tools: [
    {
      name: 'mcp_git_status',
      description: 'Get the working-tree status for a git repository.',
      inputSchema: {
        type: 'object',
        properties: { repoPath: { type: 'string' } },
      },
    },
    {
      name: 'mcp_git_diff',
      description: 'Show a unified diff of changes in a git repository.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          staged: { type: 'boolean' },
          filePath: { type: 'string' },
        },
      },
    },
    {
      name: 'mcp_git_stage',
      description: 'Stage one or more files for the next commit.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
        },
        required: ['paths'],
      },
    },
    {
      name: 'mcp_git_commit',
      description: 'Create a git commit with the given message.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['message'],
      },
    },
  ],
};

/**
 * Connect built-in servers and return the security-wrapped tools.
 * mockListTools must be configured before calling this helper.
 *
 * The order of mockResolvedValueOnce calls must match the order connectBuiltins()
 * calls connect(): file-browse first, then command-exec (if enabled), then git
 * (if enabled). getAiSdkToolsAsync() calls listTools on each connected server.
 */
async function connectBuiltinsAndGetTools(
  mgr: McpManager,
  { commandExecEnabled = false, gitEnabled = false }: { commandExecEnabled?: boolean; gitEnabled?: boolean } = {},
): Promise<Record<string, Tool>> {
  // Queue up listTools responses in the order servers will be queried
  let chain = mockListTools.mockResolvedValueOnce(FILE_BROWSE_TOOL_LIST);
  if (commandExecEnabled) {
    chain = chain.mockResolvedValueOnce(COMMAND_EXEC_TOOL_LIST);
  }
  if (gitEnabled) {
    chain.mockResolvedValueOnce(GIT_TOOL_LIST);
  }
  await mgr.connectBuiltins();
  return mgr.getAiSdkToolsAsync();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('McpManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Re-apply default implementations after clearAllMocks.
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [] });

    (Client as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      connect: mockConnect,
      close: mockClose,
      listTools: mockListTools,
      callTool: mockCallTool,
    }));
    (StdioClientTransport as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: unknown) => {
        mockTransportConstructor(opts);
        return { _opts: opts };
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── constructor ─────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('creates instance without error given a valid config', () => {
      expect(() => makeManager()).not.toThrow();
    });

    it('starts with no active connections', () => {
      const mgr = makeManager();
      expect(mgr.getConnectionStatus()).toEqual({});
    });
  });

  // ─── connect() ────────────────────────────────────────────────────────────

  describe('connect()', () => {
    it('constructs StdioClientTransport with correct command, args, and env', async () => {
      const mgr = makeManager();
      await mgr.connect(SERVER_CONFIG);

      expect(StdioClientTransport).toHaveBeenCalledOnce();
      expect(StdioClientTransport).toHaveBeenCalledWith({
        command: 'node',
        args: ['server.js'],
        env: { NODE_ENV: 'test' },
      });
    });

    it('constructs Client with uplnk identity and tool capabilities', async () => {
      const mgr = makeManager();
      await mgr.connect(SERVER_CONFIG);

      expect(Client).toHaveBeenCalledWith(
        { name: 'uplnk', version: '0.3.0' },
        { capabilities: {} },
      );
    });

    it('calls client.connect() with the transport', async () => {
      const mgr = makeManager();
      await mgr.connect(SERVER_CONFIG);

      expect(mockConnect).toHaveBeenCalledOnce();
    });

    it('marks connection status as connected after successful connect', async () => {
      const mgr = makeManager();
      await mgr.connect(SERVER_CONFIG);

      expect(mgr.getConnectionStatus()).toEqual({ 'test-server': 'connected' });
    });

    it('defaults args to [] when not provided in server config', async () => {
      const mgr = makeManager();
      await mgr.connect({ id: 'minimal', name: 'Minimal', command: 'npx' });

      expect(StdioClientTransport).toHaveBeenCalledWith(
        expect.objectContaining({ args: [] }),
      );
    });

    it('is idempotent: a second connect() for the same server ID is a no-op', async () => {
      const mgr = makeManager();
      await mgr.connect(SERVER_CONFIG);
      await mgr.connect(SERVER_CONFIG); // second call

      expect(mockConnect).toHaveBeenCalledOnce();
      expect(Client).toHaveBeenCalledOnce();
    });

    it('throws and removes the connection entry when client.connect() rejects', async () => {
      mockConnect.mockRejectedValueOnce(new Error('ENOENT: no such file'));

      const mgr = makeManager();
      await expect(mgr.connect(SERVER_CONFIG)).rejects.toThrow('ENOENT: no such file');
      expect(mgr.getConnectionStatus()).toEqual({});
    });

    it('wraps a non-Error rejection in an Error instance', async () => {
      mockConnect.mockRejectedValueOnce('string error');

      const mgr = makeManager();
      await expect(mgr.connect(SERVER_CONFIG)).rejects.toBeInstanceOf(Error);
    });

    it('throws when called after destroy()', async () => {
      const mgr = makeManager();
      await mgr.destroy();

      await expect(mgr.connect(SERVER_CONFIG)).rejects.toThrow('McpManager has been destroyed');
    });
  });

  // ─── disconnect() ─────────────────────────────────────────────────────────

  describe('disconnect()', () => {
    it('calls client.close() and removes the connection', async () => {
      const mgr = makeManager();
      await mgr.connect(SERVER_CONFIG);
      await mgr.disconnect(SERVER_CONFIG.id);

      expect(mockClose).toHaveBeenCalledOnce();
      expect(mgr.getConnectionStatus()).toEqual({});
    });

    it('is a no-op when the server ID is not known', async () => {
      const mgr = makeManager();
      await expect(mgr.disconnect('ghost-server')).resolves.toBeUndefined();
      expect(mockClose).not.toHaveBeenCalled();
    });

    it('does not throw even when client.close() rejects (best-effort close)', async () => {
      mockClose.mockRejectedValueOnce(new Error('already closed'));

      const mgr = makeManager();
      await mgr.connect(SERVER_CONFIG);
      await expect(mgr.disconnect(SERVER_CONFIG.id)).resolves.toBeUndefined();
      expect(mgr.getConnectionStatus()).toEqual({});
    });

    it('removes the connection from status after disconnect even on close error', async () => {
      mockClose.mockRejectedValueOnce(new Error('transport error'));

      const mgr = makeManager();
      await mgr.connect(SERVER_CONFIG);
      await mgr.disconnect(SERVER_CONFIG.id);

      expect(mgr.getConnectionStatus()['test-server']).toBeUndefined();
    });
  });

  // ─── destroy() ────────────────────────────────────────────────────────────

  describe('destroy()', () => {
    it('disconnects all active connections', async () => {
      const mgr = makeManager();
      await mgr.connect(SERVER_CONFIG);
      await mgr.connect({ id: 'server-b', name: 'B', command: 'node', args: ['b.js'] });
      await mgr.destroy();

      expect(mockClose).toHaveBeenCalledTimes(2);
      expect(mgr.getConnectionStatus()).toEqual({});
    });

    it('sets destroyed flag so subsequent connect() throws', async () => {
      const mgr = makeManager();
      await mgr.destroy();

      await expect(mgr.connect(SERVER_CONFIG)).rejects.toThrow('McpManager has been destroyed');
    });

    it('is safe to call on an empty manager', async () => {
      const mgr = makeManager();
      await expect(mgr.destroy()).resolves.toBeUndefined();
    });

    it('settles all disconnects even when some close() calls reject', async () => {
      mockClose.mockRejectedValue(new Error('close failed'));

      const mgr = makeManager();
      await mgr.connect(SERVER_CONFIG);
      await mgr.connect({ id: 'server-b', name: 'B', command: 'node', args: ['b.js'] });

      await expect(mgr.destroy()).resolves.toBeUndefined();
    });
  });

  // ─── getAiSdkTools() ──────────────────────────────────────────────────────

  describe('getAiSdkTools()', () => {
    it('returns empty map — built-in tools are now in child processes (ADR-004)', () => {
      expect(makeManager().getAiSdkTools()).toEqual({});
    });

    it('returns empty map even when commandExecEnabled is true', () => {
      expect(makeManager({ commandExecEnabled: true }).getAiSdkTools()).toEqual({});
    });
  });

  // ─── connectBuiltins() ────────────────────────────────────────────────────

  describe('connectBuiltins()', () => {
    it('connects to the built-in file-browse server', async () => {
      const mgr = makeManager();
      await mgr.connectBuiltins();

      expect(mgr.getConnectionStatus()[BUILTIN_FILE_BROWSE_ID]).toBe('connected');
    });

    it('does NOT connect to command-exec when commandExecEnabled is false', async () => {
      const mgr = makeManager({ commandExecEnabled: false });
      await mgr.connectBuiltins();

      expect(mgr.getConnectionStatus()[BUILTIN_COMMAND_EXEC_ID]).toBeUndefined();
    });

    it('connects to command-exec when commandExecEnabled is true', async () => {
      const mgr = makeManager({ commandExecEnabled: true });
      await mgr.connectBuiltins();

      expect(mgr.getConnectionStatus()[BUILTIN_COMMAND_EXEC_ID]).toBe('connected');
    });

    it('is idempotent — second call is a no-op', async () => {
      const mgr = makeManager();
      await mgr.connectBuiltins();
      await mgr.connectBuiltins(); // second call

      // connect() is idempotent per existing tests — Client constructed once
      expect(Client).toHaveBeenCalledOnce();
    });

    it('does NOT connect to git server when gitEnabled is false', async () => {
      const mgr = makeManager({ gitEnabled: false });
      await mgr.connectBuiltins();

      expect(mgr.getConnectionStatus()[BUILTIN_GIT_ID]).toBeUndefined();
    });

    it('connects to git server when gitEnabled is true', async () => {
      const mgr = makeManager({ gitEnabled: true });
      await mgr.connectBuiltins();

      expect(mgr.getConnectionStatus()[BUILTIN_GIT_ID]).toBe('connected');
    });
  });

  // ─── getAiSdkToolsAsync() after connectBuiltins() ─────────────────────────

  describe('getAiSdkToolsAsync() — built-in tool registry', () => {
    it('includes mcp_file_read and mcp_file_list after connectBuiltins()', async () => {
      const mgr = makeManager();
      const tools = await connectBuiltinsAndGetTools(mgr);

      expect(tools).toHaveProperty('mcp_file_read');
      expect(tools).toHaveProperty('mcp_file_list');
    });

    it('does NOT include mcp_command_exec when commandExecEnabled is false', async () => {
      const mgr = makeManager({ commandExecEnabled: false });
      const tools = await connectBuiltinsAndGetTools(mgr);

      expect(tools).not.toHaveProperty('mcp_command_exec');
    });

    it('includes mcp_command_exec when commandExecEnabled is true', async () => {
      const mgr = makeManager({ commandExecEnabled: true });
      const tools = await connectBuiltinsAndGetTools(mgr, { commandExecEnabled: true });

      expect(tools).toHaveProperty('mcp_command_exec');
    });

    it('each tool has description, parameters, and execute fields (Vercel AI SDK shape)', async () => {
      const mgr = makeManager({ commandExecEnabled: true });
      const tools = await connectBuiltinsAndGetTools(mgr, { commandExecEnabled: true });

      for (const [name, tool] of Object.entries(tools)) {
        expect(tool, `tool "${name}" missing description`).toHaveProperty('description');
        expect(tool, `tool "${name}" missing parameters`).toHaveProperty('parameters');
        expect(tool, `tool "${name}" missing execute`).toHaveProperty('execute');
      }
    });

    it('does NOT include git tools when gitEnabled is false', async () => {
      const mgr = makeManager({ gitEnabled: false });
      const tools = await connectBuiltinsAndGetTools(mgr);

      expect(tools).not.toHaveProperty('mcp_git_status');
      expect(tools).not.toHaveProperty('mcp_git_diff');
      expect(tools).not.toHaveProperty('mcp_git_stage');
      expect(tools).not.toHaveProperty('mcp_git_commit');
    });

    it('includes all four git tools when gitEnabled is true', async () => {
      const mgr = makeManager({ gitEnabled: true });
      const tools = await connectBuiltinsAndGetTools(mgr, { gitEnabled: true });

      expect(tools).toHaveProperty('mcp_git_status');
      expect(tools).toHaveProperty('mcp_git_diff');
      expect(tools).toHaveProperty('mcp_git_stage');
      expect(tools).toHaveProperty('mcp_git_commit');
    });
  });

  // ─── mcp_file_read security wrapper ──────────────────────────────────────

  describe('mcp_file_read — security validation (pre-call, in parent process)', () => {
    async function getFileReadTool(mgr: McpManager): Promise<NonNullable<Tool>> {
      const tools = await connectBuiltinsAndGetTools(mgr);
      return tools['mcp_file_read']!;
    }

    it('throws MCP_TOOL_DENIED for a path outside the allowed root', async () => {
      const mgr = makeManager();
      const tool = await getFileReadTool(mgr);

      await expect(
        tool.execute!({ path: '/etc/passwd' }, { toolCallId: 't1', messages: [] }),
      ).rejects.toThrow('MCP_TOOL_DENIED');

      // Security check blocks the call — child process must NOT be invoked
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('throws MCP_TOOL_DENIED for a path traversal attempt', async () => {
      const mgr = makeManager();
      const tool = await getFileReadTool(mgr);

      await expect(
        tool.execute!(
          { path: join(ALLOWED_ROOT, '../../etc/shadow') },
          { toolCallId: 't2', messages: [] },
        ),
      ).rejects.toThrow('MCP_TOOL_DENIED');

      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('throws MCP_TOOL_DENIED for .env files even inside allowed root', async () => {
      const mgr = makeManager();
      const tool = await getFileReadTool(mgr);

      await expect(
        tool.execute!(
          { path: join(ALLOWED_ROOT, '.env') },
          { toolCallId: 't3', messages: [] },
        ),
      ).rejects.toThrow('MCP_TOOL_DENIED');

      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('throws MCP_TOOL_DENIED when file exceeds the size limit', async () => {
      // 2 MiB > 1 MiB maxReadBytes limit
      mockStatSync.mockReturnValueOnce({ size: 2 * 1024 * 1024 });

      const mgr = makeManager();
      const tool = await getFileReadTool(mgr);

      await expect(
        tool.execute!(
          { path: join(ALLOWED_ROOT, 'large.bin') },
          { toolCallId: 't4', messages: [] },
        ),
      ).rejects.toThrow('MCP_TOOL_DENIED');

      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('forwards call to child process for an allowed path within size limit', async () => {
      mockStatSync.mockReturnValueOnce({ size: 100 });
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'file contents' }],
      });

      const mgr = makeManager();
      const tool = await getFileReadTool(mgr);

      const result = await tool.execute!(
        { path: join(ALLOWED_ROOT, 'src/main.ts') },
        { toolCallId: 't5', messages: [] },
      );

      expect(result).toBe('file contents');
      expect(mockCallTool).toHaveBeenCalledOnce();
    });

    it('forwards the resolved (canonical) path to the child, not the raw input path', async () => {
      mockStatSync.mockReturnValueOnce({ size: 100 });
      mockCallTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] });

      const mgr = makeManager();
      const tool = await getFileReadTool(mgr);
      const allowedPath = join(ALLOWED_ROOT, 'src/main.ts');

      await tool.execute!({ path: allowedPath }, { toolCallId: 't6', messages: [] });

      const callArgs = mockCallTool.mock.calls[0]![0] as { arguments: Record<string, unknown> };
      expect(callArgs.arguments['path']).toBe(allowedPath); // realpathSync is identity in tests
    });
  });

  // ─── mcp_file_list security wrapper ──────────────────────────────────────

  describe('mcp_file_list — security validation (pre-call, in parent process)', () => {
    async function getFileListTool(mgr: McpManager): Promise<NonNullable<Tool>> {
      const tools = await connectBuiltinsAndGetTools(mgr);
      return tools['mcp_file_list']!;
    }

    it('throws MCP_TOOL_DENIED for a directory outside the allowed root', async () => {
      const mgr = makeManager();
      const tool = await getFileListTool(mgr);

      await expect(
        tool.execute!({ path: '/var/log' }, { toolCallId: 'l1', messages: [] }),
      ).rejects.toThrow('MCP_TOOL_DENIED');

      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('forwards call to child process for an allowed directory', async () => {
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'src/\nREADME.md  (2 KB)' }],
      });

      const mgr = makeManager();
      const tool = await getFileListTool(mgr);

      const result = await tool.execute!(
        { path: ALLOWED_ROOT },
        { toolCallId: 'l2', messages: [] },
      );

      expect(result).toContain('src/');
      expect(mockCallTool).toHaveBeenCalledOnce();
    });
  });

  // ─── mcp_command_exec security wrapper ───────────────────────────────────

  describe('mcp_command_exec — security validation + approval gate', () => {
    async function getCommandExecTool(mgr: McpManager): Promise<NonNullable<Tool>> {
      const tools = await connectBuiltinsAndGetTools(mgr, { commandExecEnabled: true });
      return tools['mcp_command_exec']!;
    }

    it('throws MCP_TOOL_DENIED immediately for a dangerous command pattern', async () => {
      const approval = makeApproval(true);
      const mgr = makeManager({ commandExecEnabled: true, approval });
      const tool = await getCommandExecTool(mgr);

      await expect(
        tool.execute!(
          { command: 'rm', args: ['-rf', '/'] },
          { toolCallId: 'c1', messages: [] },
        ),
      ).rejects.toThrow('MCP_TOOL_DENIED');

      // Approval must NOT be requested for structurally blocked commands
      expect(approval).not.toHaveBeenCalled();
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('throws MCP_TOOL_DENIED and does not call child when user denies approval', async () => {
      const approval = makeApproval(false);
      const mgr = makeManager({ commandExecEnabled: true, approval });
      const tool = await getCommandExecTool(mgr);

      await expect(
        tool.execute!(
          { command: 'ls', args: ['-la'], cwd: ALLOWED_ROOT },
          { toolCallId: 'c2', messages: [] },
        ),
      ).rejects.toThrow('User denied command execution');

      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('calls requestApproval with correct id, command, args, and cwd', async () => {
      const approval = makeApproval(false); // deny to avoid callTool
      const mgr = makeManager({ commandExecEnabled: true, approval });
      const tool = await getCommandExecTool(mgr);

      await expect(
        tool.execute!(
          { command: 'git', args: ['status'], cwd: ALLOWED_ROOT, description: 'check status' },
          { toolCallId: 'c3', messages: [] },
        ),
      ).rejects.toThrow();

      expect(approval).toHaveBeenCalledOnce();
      const call = approval.mock.calls[0]![0];
      expect(call).toMatchObject({
        command: 'git',
        args: ['status'],
        cwd: ALLOWED_ROOT,
        description: 'check status',
      });
      expect(call.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('forwards call to child process and returns output when approved', async () => {
      const approval = makeApproval(true);
      const mgr = makeManager({ commandExecEnabled: true, approval });
      const tool = await getCommandExecTool(mgr);

      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: '* main\n' }],
      });

      const result = await tool.execute!(
        { command: 'git', args: ['branch'], cwd: ALLOWED_ROOT },
        { toolCallId: 'c4', messages: [] },
      );

      expect(result).toContain('main');
      expect(mockCallTool).toHaveBeenCalledOnce();
    });

    it('throws MCP_TOOL_DENIED when cwd is outside allowed root', async () => {
      const approval = makeApproval(true);
      const mgr = makeManager({ commandExecEnabled: true, approval });
      const tool = await getCommandExecTool(mgr);

      await expect(
        tool.execute!(
          { command: 'ls', args: [], cwd: '/etc' },
          { toolCallId: 'c5', messages: [] },
        ),
      ).rejects.toThrow('MCP_TOOL_DENIED');

      expect(approval).not.toHaveBeenCalled();
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('blocks mkfs even in args (full command string is checked)', async () => {
      const approval = makeApproval(true);
      const mgr = makeManager({ commandExecEnabled: true, approval });
      const tool = await getCommandExecTool(mgr);

      await expect(
        tool.execute!(
          { command: 'mkfs', args: ['-t', 'ext4', '/dev/sda'] },
          { toolCallId: 'c6', messages: [] },
        ),
      ).rejects.toThrow('MCP_TOOL_DENIED');
    });
  });

  // ─── mcp_file_write security wrapper ─────────────────────────────────────

  describe('mcp_file_write — security validation + approval gate', () => {
    async function getFileWriteTool(mgr: McpManager): Promise<NonNullable<Tool>> {
      const tools = await connectBuiltinsAndGetTools(mgr);
      return tools['mcp_file_write']!;
    }

    it('throws MCP_TOOL_DENIED for a path outside the allowed root', async () => {
      const mgr = makeManager();
      const tool = await getFileWriteTool(mgr);

      await expect(
        tool.execute!({ path: '/tmp/evil.txt', content: 'bad' }, { toolCallId: 'w1', messages: [] }),
      ).rejects.toThrow('MCP_TOOL_DENIED');

      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('throws MCP_TOOL_DENIED for a .env file even inside allowed root', async () => {
      const mgr = makeManager();
      const tool = await getFileWriteTool(mgr);

      await expect(
        tool.execute!(
          { path: join(ALLOWED_ROOT, '.env'), content: 'SECRET=x' },
          { toolCallId: 'w2', messages: [] },
        ),
      ).rejects.toThrow('MCP_TOOL_DENIED');

      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('throws MCP_TOOL_DENIED when content exceeds 512 KiB', async () => {
      const mgr = makeManager();
      const tool = await getFileWriteTool(mgr);

      // 513 KiB string
      const oversized = 'x'.repeat(513 * 1024);

      await expect(
        tool.execute!(
          { path: join(ALLOWED_ROOT, 'big.txt'), content: oversized },
          { toolCallId: 'w3', messages: [] },
        ),
      ).rejects.toThrow('MCP_TOOL_DENIED');

      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('throws MCP_TOOL_DENIED and does not call child when user denies approval', async () => {
      const approval = makeApproval(false);
      const mgr = makeManager({ approval });
      const tool = await getFileWriteTool(mgr);

      await expect(
        tool.execute!(
          { path: join(ALLOWED_ROOT, 'output.txt'), content: 'hello' },
          { toolCallId: 'w4', messages: [] },
        ),
      ).rejects.toThrow('User denied file write');

      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('calls requestApproval with file_write command and resolved path', async () => {
      const approval = makeApproval(false); // deny to skip callTool
      const mgr = makeManager({ approval });
      const tool = await getFileWriteTool(mgr);
      const targetPath = join(ALLOWED_ROOT, 'src/out.ts');

      await expect(
        tool.execute!({ path: targetPath, content: 'export {}' }, { toolCallId: 'w5', messages: [] }),
      ).rejects.toThrow();

      expect(approval).toHaveBeenCalledOnce();
      const call = approval.mock.calls[0]![0];
      expect(call.command).toBe('file_write');
      expect(call.args).toEqual([targetPath]);
      expect(call.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('forwards call to child process and returns output when approved', async () => {
      const approval = makeApproval(true);
      const mgr = makeManager({ approval });
      const tool = await getFileWriteTool(mgr);

      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Written 5 bytes to /projects/myapp/out.txt' }],
      });

      const result = await tool.execute!(
        { path: join(ALLOWED_ROOT, 'out.txt'), content: 'hello' },
        { toolCallId: 'w6', messages: [] },
      );

      expect(result).toContain('Written');
      expect(mockCallTool).toHaveBeenCalledOnce();
    });
  });

  // ─── mcp_file_patch security wrapper ─────────────────────────────────────

  describe('mcp_file_patch — security validation + approval gate', () => {
    async function getFilePatchTool(mgr: McpManager): Promise<NonNullable<Tool>> {
      const tools = await connectBuiltinsAndGetTools(mgr);
      return tools['mcp_file_patch']!;
    }

    it('throws MCP_TOOL_DENIED for a path outside the allowed root', async () => {
      const mgr = makeManager();
      const tool = await getFilePatchTool(mgr);

      await expect(
        tool.execute!(
          { path: '/etc/hosts', patch: '--- a/hosts\n+++ b/hosts\n@@ -1 +1 @@\n-127.0.0.1\n+0.0.0.0' },
          { toolCallId: 'p1', messages: [] },
        ),
      ).rejects.toThrow('MCP_TOOL_DENIED');

      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('throws MCP_TOOL_DENIED and does not call child when user denies approval', async () => {
      const approval = makeApproval(false);
      const mgr = makeManager({ approval });
      const tool = await getFilePatchTool(mgr);

      await expect(
        tool.execute!(
          { path: join(ALLOWED_ROOT, 'src/main.ts'), patch: '--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-old\n+new' },
          { toolCallId: 'p2', messages: [] },
        ),
      ).rejects.toThrow('User denied file patch');

      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('calls requestApproval with file_patch command and resolved path', async () => {
      const approval = makeApproval(false); // deny to skip callTool
      const mgr = makeManager({ approval });
      const tool = await getFilePatchTool(mgr);
      const targetPath = join(ALLOWED_ROOT, 'src/main.ts');

      await expect(
        tool.execute!(
          { path: targetPath, patch: '--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-old\n+new' },
          { toolCallId: 'p3', messages: [] },
        ),
      ).rejects.toThrow();

      expect(approval).toHaveBeenCalledOnce();
      const call = approval.mock.calls[0]![0];
      expect(call.command).toBe('file_patch');
      expect(call.args).toEqual([targetPath]);
      expect(call.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('forwards call to child process and returns output when approved', async () => {
      const approval = makeApproval(true);
      const mgr = makeManager({ approval });
      const tool = await getFilePatchTool(mgr);

      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Patched /projects/myapp/src/main.ts (42 bytes written)' }],
      });

      const result = await tool.execute!(
        { path: join(ALLOWED_ROOT, 'src/main.ts'), patch: '--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-old\n+new' },
        { toolCallId: 'p4', messages: [] },
      );

      expect(result).toContain('Patched');
      expect(mockCallTool).toHaveBeenCalledOnce();
    });
  });

  // ─── git tool security wrappers ──────────────────────────────────────────

  describe('mcp_git_status and mcp_git_diff — read-only, no approval needed', () => {
    async function getGitTools(mgr: McpManager) {
      const tools = await connectBuiltinsAndGetTools(mgr, { gitEnabled: true });
      return {
        status: tools['mcp_git_status']!,
        diff: tools['mcp_git_diff']!,
      };
    }

    it('mcp_git_status forwards call without requesting approval', async () => {
      const approval = makeApproval(true);
      const mgr = makeManager({ gitEnabled: true, approval });
      const { status: statusTool } = await getGitTools(mgr);

      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'On branch main\nnothing to commit' }],
      });

      const result = await statusTool.execute!(
        { repoPath: ALLOWED_ROOT },
        { toolCallId: 'gs1', messages: [] },
      );

      expect(result).toContain('main');
      expect(mockCallTool).toHaveBeenCalledOnce();
      expect(approval).not.toHaveBeenCalled();
    });

    it('mcp_git_diff forwards call without requesting approval', async () => {
      const approval = makeApproval(true);
      const mgr = makeManager({ gitEnabled: true, approval });
      const { diff: diffTool } = await getGitTools(mgr);

      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'diff --git a/src/foo.ts b/src/foo.ts' }],
      });

      const result = await diffTool.execute!(
        { repoPath: ALLOWED_ROOT, staged: false },
        { toolCallId: 'gd1', messages: [] },
      );

      expect(result).toContain('diff --git');
      expect(mockCallTool).toHaveBeenCalledOnce();
      expect(approval).not.toHaveBeenCalled();
    });

    it('mcp_git_status throws MCP_TOOL_DENIED for repoPath outside allowed root', async () => {
      const mgr = makeManager({ gitEnabled: true });
      const { status: statusTool } = await getGitTools(mgr);

      await expect(
        statusTool.execute!(
          { repoPath: '/etc' },
          { toolCallId: 'gs2', messages: [] },
        ),
      ).rejects.toThrow('MCP_TOOL_DENIED');

      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('mcp_git_diff throws MCP_TOOL_DENIED for repoPath outside allowed root', async () => {
      const mgr = makeManager({ gitEnabled: true });
      const { diff: diffTool } = await getGitTools(mgr);

      await expect(
        diffTool.execute!(
          { repoPath: '/var/log' },
          { toolCallId: 'gd2', messages: [] },
        ),
      ).rejects.toThrow('MCP_TOOL_DENIED');

      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('mcp_git_status forwards without repoPath (uses server cwd default)', async () => {
      const mgr = makeManager({ gitEnabled: true });
      const { status: statusTool } = await getGitTools(mgr);

      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'On branch main' }],
      });

      const result = await statusTool.execute!(
        {},
        { toolCallId: 'gs3', messages: [] },
      );

      expect(result).toContain('main');
      expect(mockCallTool).toHaveBeenCalledOnce();
    });
  });

  describe('mcp_git_stage — mutating, requires approval', () => {
    async function getGitStageTool(mgr: McpManager): Promise<NonNullable<Tool>> {
      const tools = await connectBuiltinsAndGetTools(mgr, { gitEnabled: true });
      return tools['mcp_git_stage']!;
    }

    it('requires approval before staging files', async () => {
      const approval = makeApproval(false); // deny to check approval was requested
      const mgr = makeManager({ gitEnabled: true, approval });
      const tool = await getGitStageTool(mgr);

      await expect(
        tool.execute!(
          { repoPath: ALLOWED_ROOT, paths: ['src/foo.ts'] },
          { toolCallId: 'gst1', messages: [] },
        ),
      ).rejects.toThrow('User denied git stage');

      expect(approval).toHaveBeenCalledOnce();
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('forwards call to child process when approved', async () => {
      const approval = makeApproval(true);
      const mgr = makeManager({ gitEnabled: true, approval });
      const tool = await getGitStageTool(mgr);

      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Staged 1 file' }],
      });

      const result = await tool.execute!(
        { repoPath: ALLOWED_ROOT, paths: ['src/foo.ts'] },
        { toolCallId: 'gst2', messages: [] },
      );

      expect(result).toContain('Staged');
      expect(mockCallTool).toHaveBeenCalledOnce();
    });

    it('throws MCP_TOOL_DENIED for repoPath outside allowed root — no approval requested', async () => {
      const approval = makeApproval(true);
      const mgr = makeManager({ gitEnabled: true, approval });
      const tool = await getGitStageTool(mgr);

      await expect(
        tool.execute!(
          { repoPath: '/etc', paths: ['hosts'] },
          { toolCallId: 'gst3', messages: [] },
        ),
      ).rejects.toThrow('MCP_TOOL_DENIED');

      expect(approval).not.toHaveBeenCalled();
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('calls requestApproval with git_stage command, paths as args, and repoPath as cwd', async () => {
      const approval = makeApproval(false);
      const mgr = makeManager({ gitEnabled: true, approval });
      const tool = await getGitStageTool(mgr);

      await expect(
        tool.execute!(
          { repoPath: ALLOWED_ROOT, paths: ['src/a.ts', 'src/b.ts'] },
          { toolCallId: 'gst4', messages: [] },
        ),
      ).rejects.toThrow();

      expect(approval).toHaveBeenCalledOnce();
      const call = approval.mock.calls[0]![0];
      expect(call.command).toBe('git_stage');
      expect(call.args).toEqual(['src/a.ts', 'src/b.ts']);
      expect(call.cwd).toBe(ALLOWED_ROOT);
      expect(call.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  describe('mcp_git_commit — mutating, requires approval', () => {
    async function getGitCommitTool(mgr: McpManager): Promise<NonNullable<Tool>> {
      const tools = await connectBuiltinsAndGetTools(mgr, { gitEnabled: true });
      return tools['mcp_git_commit']!;
    }

    it('requires approval before creating a commit', async () => {
      const approval = makeApproval(false);
      const mgr = makeManager({ gitEnabled: true, approval });
      const tool = await getGitCommitTool(mgr);

      await expect(
        tool.execute!(
          { repoPath: ALLOWED_ROOT, message: 'fix: typo in README' },
          { toolCallId: 'gc1', messages: [] },
        ),
      ).rejects.toThrow('User denied git commit');

      expect(approval).toHaveBeenCalledOnce();
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('forwards call to child process when approved', async () => {
      const approval = makeApproval(true);
      const mgr = makeManager({ gitEnabled: true, approval });
      const tool = await getGitCommitTool(mgr);

      mockCallTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Created commit abc1234: fix: typo in README' }],
      });

      const result = await tool.execute!(
        { repoPath: ALLOWED_ROOT, message: 'fix: typo in README' },
        { toolCallId: 'gc2', messages: [] },
      );

      expect(result).toContain('abc1234');
      expect(mockCallTool).toHaveBeenCalledOnce();
    });

    it('throws MCP_TOOL_DENIED for repoPath outside allowed root — no approval requested', async () => {
      const approval = makeApproval(true);
      const mgr = makeManager({ gitEnabled: true, approval });
      const tool = await getGitCommitTool(mgr);

      await expect(
        tool.execute!(
          { repoPath: '/tmp', message: 'evil commit' },
          { toolCallId: 'gc3', messages: [] },
        ),
      ).rejects.toThrow('MCP_TOOL_DENIED');

      expect(approval).not.toHaveBeenCalled();
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('calls requestApproval with git_commit command, message as arg, and repoPath as cwd', async () => {
      const approval = makeApproval(false);
      const mgr = makeManager({ gitEnabled: true, approval });
      const tool = await getGitCommitTool(mgr);
      const msg = 'feat: add git MCP server';

      await expect(
        tool.execute!(
          { repoPath: ALLOWED_ROOT, message: msg },
          { toolCallId: 'gc4', messages: [] },
        ),
      ).rejects.toThrow();

      expect(approval).toHaveBeenCalledOnce();
      const call = approval.mock.calls[0]![0];
      expect(call.command).toBe('git_commit');
      expect(call.args).toEqual([msg]);
      expect(call.cwd).toBe(ALLOWED_ROOT);
      expect(call.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  // ─── getConnectionStatus() ────────────────────────────────────────────────

  describe('getConnectionStatus()', () => {
    it('returns empty object when no connections exist', () => {
      expect(makeManager().getConnectionStatus()).toEqual({});
    });

    it('tracks multiple connections independently', async () => {
      const mgr = makeManager();
      await mgr.connect(SERVER_CONFIG);
      await mgr.connect({ id: 'server-b', name: 'B', command: 'python3', args: ['server.py'] });

      const status = mgr.getConnectionStatus();
      expect(status['test-server']).toBe('connected');
      expect(status['server-b']).toBe('connected');
    });

    it('removes entry after disconnect', async () => {
      const mgr = makeManager();
      await mgr.connect(SERVER_CONFIG);
      await mgr.disconnect(SERVER_CONFIG.id);

      expect(mgr.getConnectionStatus()).not.toHaveProperty('test-server');
    });
  });
});
