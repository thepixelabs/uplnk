/**
 * Unit tests for McpManager's wrapRagTools() security wrapper.
 *
 * Verifies:
 * - mcp_rag_index validates the target directory against allowedRoots
 * - mcp_rag_index is denied when directory is outside allowed roots
 * - mcp_rag_index is allowed when directory is inside allowed roots
 * - mcp_rag_search passes through without path validation (read-only)
 *
 * Strategy: same as McpManager.test.ts — mock the MCP SDK at module boundary,
 * inject fake tool handlers that capture args, then verify the security
 * wrapper's behaviour.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── SDK mocks ─────────────────────────────────────────────────────────────────

const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockListTools = vi.fn();
const mockCallTool = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockClose,
    listTools: mockListTools,
    callTool: mockCallTool,
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation((opts: unknown) => ({
    _opts: opts,
    onclose: undefined,
    onerror: undefined,
  })),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: vi.fn(),
    realpathSync: (p: string) => p, // identity — no real FS
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
  };
});

// ─── Imports ───────────────────────────────────────────────────────────────────

import { McpManager, BUILTIN_RAG_ID } from '../../mcp/McpManager.js';
import { createDefaultPolicy } from '../../mcp/security.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const ALLOWED_ROOT = '/projects/myapp';

function makePolicy() {
  return createDefaultPolicy([ALLOWED_ROOT]);
}

const RAG_TOOL_LIST = {
  tools: [
    {
      name: 'mcp_rag_search',
      description: 'Semantically search the indexed codebase.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          topK: { type: 'number' },
          directory: { type: 'string' },
        },
        required: ['query'],
      },
    },
    {
      name: 'mcp_rag_index',
      description: 'Index all files under a directory.',
      inputSchema: {
        type: 'object',
        properties: {
          directory: { type: 'string' },
        },
        required: ['directory'],
      },
    },
  ],
};

function makeRagManager() {
  return new McpManager({
    filePolicy: makePolicy(),
    commandExecEnabled: false,
    gitEnabled: false,
    ragEnabled: true,
    requestApproval: vi.fn().mockResolvedValue(true),
  });
}

/**
 * Simulate a connected RAG server by injecting a fake connection
 * into the manager's internal connections map.
 */
function injectFakeRagConnection(manager: McpManager): void {
  // Access the private connections map for testing
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connections = (manager as any)['connections'] as Map<string, {
    config: unknown;
    client: unknown;
    transport: unknown;
    status: string;
  }>;

  connections.set(BUILTIN_RAG_ID, {
    config: { id: BUILTIN_RAG_ID, name: 'pylon-rag' },
    client: {
      listTools: mockListTools,
      callTool: mockCallTool,
    },
    transport: {},
    status: 'connected',
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('wrapRagTools — mcp_rag_index security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListTools.mockResolvedValue(RAG_TOOL_LIST);
    // Default callTool succeeds
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'Indexed 5 files, 12 chunks, skipped 0 files.' }],
    });
  });

  it('denies mcp_rag_index when directory is outside allowed roots', async () => {
    const manager = makeRagManager();
    injectFakeRagConnection(manager);

    const tools = await manager.getAiSdkToolsAsync();
    const indexTool = tools['mcp_rag_index'];
    expect(indexTool).toBeDefined();

    await expect(
      indexTool!.execute!(
        { directory: '/etc/secrets' },
        undefined as never,
      ),
    ).rejects.toThrow(/MCP_TOOL_DENIED/);

    // callTool should NOT have been invoked
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('denies mcp_rag_index for path traversal attempts', async () => {
    const manager = makeRagManager();
    injectFakeRagConnection(manager);

    const tools = await manager.getAiSdkToolsAsync();
    const indexTool = tools['mcp_rag_index'];

    await expect(
      indexTool!.execute!(
        { directory: '/projects/myapp/../../etc' },
        undefined as never,
      ),
    ).rejects.toThrow(/MCP_TOOL_DENIED/);

    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('allows mcp_rag_index when directory is inside allowed roots', async () => {
    const manager = makeRagManager();
    injectFakeRagConnection(manager);

    const tools = await manager.getAiSdkToolsAsync();
    const indexTool = tools['mcp_rag_index'];

    await expect(
      indexTool!.execute!(
        { directory: ALLOWED_ROOT + '/src' },
        undefined as never,
      ),
    ).resolves.toBeDefined();

    // callTool should have been forwarded to the child
    expect(mockCallTool).toHaveBeenCalledOnce();
    expect(mockCallTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'mcp_rag_index',
        arguments: expect.objectContaining({
          directory: ALLOWED_ROOT + '/src',
        }),
      }),
    );
  });

  it('allows mcp_rag_index for the exact allowed root', async () => {
    const manager = makeRagManager();
    injectFakeRagConnection(manager);

    const tools = await manager.getAiSdkToolsAsync();
    const indexTool = tools['mcp_rag_index'];

    await expect(
      indexTool!.execute!(
        { directory: ALLOWED_ROOT },
        undefined as never,
      ),
    ).resolves.toBeDefined();

    expect(mockCallTool).toHaveBeenCalledOnce();
  });
});

describe('wrapRagTools — mcp_rag_search security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListTools.mockResolvedValue(RAG_TOOL_LIST);
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: '[1] /projects/myapp/src/index.ts (chunk 0, score: 92.3%)\nexport function main() {}' }],
    });
  });

  it('passes mcp_rag_search through without path validation', async () => {
    const manager = makeRagManager();
    injectFakeRagConnection(manager);

    const tools = await manager.getAiSdkToolsAsync();
    const searchTool = tools['mcp_rag_search'];
    expect(searchTool).toBeDefined();

    // Should NOT throw — mcp_rag_search is read-only and needs no path validation
    await expect(
      searchTool!.execute!(
        { query: 'function that handles HTTP requests', topK: 3 },
        undefined as never,
      ),
    ).resolves.toBeDefined();

    expect(mockCallTool).toHaveBeenCalledOnce();
    expect(mockCallTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'mcp_rag_search',
        arguments: expect.objectContaining({ query: 'function that handles HTTP requests' }),
      }),
    );
  });

  it('mcp_rag_search does not validate query content against file policy', async () => {
    const manager = makeRagManager();
    injectFakeRagConnection(manager);

    const tools = await manager.getAiSdkToolsAsync();
    const searchTool = tools['mcp_rag_search'];

    // Even a query that looks like a path outside allowed roots should succeed
    // (the query is not a path — it's free-form text)
    await expect(
      searchTool!.execute!(
        { query: '/etc/passwd file reading logic' },
        undefined as never,
      ),
    ).resolves.toBeDefined();
  });
});

describe('BUILTIN_RAG_ID constant', () => {
  it('has the expected sentinel value', () => {
    expect(BUILTIN_RAG_ID).toBe('__pylon_builtin_rag__');
  });
});
