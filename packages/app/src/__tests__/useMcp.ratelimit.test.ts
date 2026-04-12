/**
 * useMcp — BC-5 rate limiting tests (FINDING-008 MEDIUM)
 *
 * Tests the per-conversation tool call counter:
 *  - Normal calls pass through when under the limit
 *  - Calls at or beyond MAX_TOOL_CALLS_PER_CONVERSATION return an error result
 *  - The counter resets when conversationId changes
 *
 * Strategy:
 *  - Mock McpManager, createDefaultPolicy, readFileSync, and the approval request
 *    machinery so we can exercise only the rate limiting logic in useMcp.
 *  - McpManager.getAiSdkToolsAsync() returns a fake tool map with one tool
 *    whose execute() we can track.
 *  - We drive the hook via a thin HookWrapper rendered with ink-testing-library.
 *
 * Hoisting note: vi.mock() factories are hoisted before any const declarations.
 * vi.hoisted() runs at hoist time — do not move the fn() calls into factories.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { useState } from 'react';
import { render, cleanup } from 'ink-testing-library';
import type { Tool } from 'ai';

// ─── Hoisted mock refs ────────────────────────────────────────────────────────

const mcpManagerMocks = vi.hoisted(() => {
  const fakeExecute = vi.fn(async (): Promise<string> => 'ok');
  const fakeTools: Record<string, Tool> = {
    mcp_fake_tool: {
      description: 'Fake tool for testing',
      parameters: {
        type: 'object',
        properties: {},
        jsonSchema: { type: 'object', properties: {} },
      } as unknown as Tool['parameters'],
      execute: fakeExecute,
    },
  };

  const mockConnectBuiltins = vi.fn(async () => undefined);
  const mockConnect = vi.fn(async () => undefined);
  const mockGetAiSdkToolsAsync = vi.fn(async () => fakeTools);
  const mockDestroy = vi.fn(async () => undefined);

  return {
    fakeExecute,
    fakeTools,
    MockMcpManager: vi.fn(() => ({
      connectBuiltins: mockConnectBuiltins,
      connect: mockConnect,
      getAiSdkToolsAsync: mockGetAiSdkToolsAsync,
      destroy: mockDestroy,
    })),
    mockConnectBuiltins,
    mockConnect,
    mockGetAiSdkToolsAsync,
    mockDestroy,
  };
});

vi.mock('../lib/mcp/McpManager.js', () => ({
  McpManager: mcpManagerMocks.MockMcpManager,
  BUILTIN_FILE_BROWSE_ID: '__uplnk_builtin_file_browse__',
  BUILTIN_COMMAND_EXEC_ID: '__uplnk_builtin_command_exec__',
  BUILTIN_GIT_ID: '__uplnk_builtin_git__',
  BUILTIN_RAG_ID: '__uplnk_builtin_rag__',
}));

vi.mock('../lib/mcp/security.js', () => ({
  createDefaultPolicy: vi.fn(() => ({
    allowedRoots: ['/tmp'],
    maxFileSizeBytes: 1_000_000,
  })),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
}));

// ─── Import under test ────────────────────────────────────────────────────────

import { useMcp, MAX_TOOL_CALLS_PER_CONVERSATION } from '../hooks/useMcp.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const tick = () => new Promise<void>((r) => setImmediate(r));

/**
 * Wait for the tools map to be populated (after the async connect+enumerate cycle).
 * Polls up to maxMs with tick() intervals.
 */
async function waitForTools(
  result: { current: ReturnType<typeof useMcp> },
  maxMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (Object.keys(result.current.tools).length === 0) {
    if (Date.now() - start > maxMs) {
      throw new Error('waitForTools timed out — tools never populated');
    }
    await tick();
  }
}

interface HookOptions {
  conversationId?: string;
}

type HookResult = ReturnType<typeof useMcp>;

/**
 * Render useMcp with minimal required props.
 * Optionally accepts conversationId for testing reset behaviour.
 */
function renderHook(initialOptions: HookOptions = {}): {
  result: { current: HookResult };
  updateConversationId: (id: string) => void;
  unmount: () => void;
} {
  const result: { current: HookResult } = {
    current: undefined as unknown as HookResult,
  };

  let externalSetConversationId: (id: string) => void = () => { /* noop */ };

  function HookWrapper() {
    const [conversationId, setConversationId] = useState<string | undefined>(
      initialOptions.conversationId,
    );
    externalSetConversationId = setConversationId;

    result.current = useMcp({
      allowedPaths: [],
      commandExecEnabled: false,
      gitEnabled: false,
      ragEnabled: false,
      ...(conversationId !== undefined ? { conversationId } : {}),
    });
    return React.createElement(React.Fragment, null);
  }

  const { unmount } = render(React.createElement(HookWrapper));
  return {
    result,
    updateConversationId: (id: string) => { externalSetConversationId(id); },
    unmount,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useMcp — BC-5 rate limiting', () => {
  beforeEach(() => {
    mcpManagerMocks.fakeExecute.mockReset();
    mcpManagerMocks.fakeExecute.mockImplementation(async () => 'ok');
    mcpManagerMocks.mockGetAiSdkToolsAsync.mockImplementation(
      async () => mcpManagerMocks.fakeTools,
    );
  });

  afterEach(() => {
    cleanup();
  });

  it('exports MAX_TOOL_CALLS_PER_CONVERSATION as 100', () => {
    expect(MAX_TOOL_CALLS_PER_CONVERSATION).toBe(100);
  });

  it('allows a tool call when the count is under the limit', async () => {
    const { result, unmount } = renderHook({ conversationId: 'conv-1' });
    await waitForTools(result);

    const tool = result.current.tools['mcp_fake_tool'];
    expect(tool).toBeDefined();

    const execResult = await tool!.execute!({}, undefined as never);

    expect(execResult).toBe('ok');
    expect(mcpManagerMocks.fakeExecute).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('passes args through to the underlying tool execute()', async () => {
    const { result, unmount } = renderHook({ conversationId: 'conv-1' });
    await waitForTools(result);

    const tool = result.current.tools['mcp_fake_tool'];
    const fakeArgs = { path: '/tmp/file.txt' };
    await tool!.execute!(fakeArgs, undefined as never);

    expect(mcpManagerMocks.fakeExecute).toHaveBeenCalledWith(
      fakeArgs,
      undefined,
    );

    unmount();
  });

  it('returns an error result when the limit is exceeded', async () => {
    const { result, unmount } = renderHook({ conversationId: 'conv-1' });
    await waitForTools(result);

    const tool = result.current.tools['mcp_fake_tool'];
    expect(tool).toBeDefined();

    // Exhaust the limit
    for (let i = 0; i < MAX_TOOL_CALLS_PER_CONVERSATION; i++) {
      await tool!.execute!({}, undefined as never);
    }

    // Next call (101st) should be blocked
    const limitResult = await tool!.execute!({}, undefined as never);

    expect(limitResult).toMatchObject({
      isError: true,
      content: [
        {
          type: 'text',
          text: expect.stringContaining(
            `Tool call limit reached (${MAX_TOOL_CALLS_PER_CONVERSATION}/conversation)`,
          ),
        },
      ],
    });

    unmount();
  });

  it('does not call through to the underlying tool when the limit is exceeded', async () => {
    const { result, unmount } = renderHook({ conversationId: 'conv-1' });
    await waitForTools(result);

    const tool = result.current.tools['mcp_fake_tool'];

    // Exhaust the limit
    for (let i = 0; i < MAX_TOOL_CALLS_PER_CONVERSATION; i++) {
      await tool!.execute!({}, undefined as never);
    }

    mcpManagerMocks.fakeExecute.mockClear();

    // 101st call — should not reach the underlying tool
    await tool!.execute!({}, undefined as never);

    expect(mcpManagerMocks.fakeExecute).not.toHaveBeenCalled();

    unmount();
  });

  it('includes a suggestion to start a new conversation in the error message', async () => {
    const { result, unmount } = renderHook({ conversationId: 'conv-1' });
    await waitForTools(result);

    const tool = result.current.tools['mcp_fake_tool'];

    for (let i = 0; i < MAX_TOOL_CALLS_PER_CONVERSATION; i++) {
      await tool!.execute!({}, undefined as never);
    }

    const limitResult = (await tool!.execute!({}, undefined as never)) as {
      content: Array<{ text: string }>;
    };

    expect(limitResult.content[0]?.text).toContain('new conversation');

    unmount();
  });

  it('resets the counter when conversationId changes', async () => {
    const { result, updateConversationId, unmount } = renderHook({
      conversationId: 'conv-a',
    });
    await waitForTools(result);

    const tool = result.current.tools['mcp_fake_tool'];

    // Exhaust the limit on conv-a
    for (let i = 0; i < MAX_TOOL_CALLS_PER_CONVERSATION; i++) {
      await tool!.execute!({}, undefined as never);
    }

    // Verify it's blocked
    const blockedResult = await tool!.execute!({}, undefined as never);
    expect(blockedResult).toMatchObject({ isError: true });

    // Switch to a new conversation
    updateConversationId('conv-b');
    await tick();

    // Counter should be reset — calls should pass through again
    const afterResetResult = await tool!.execute!({}, undefined as never);
    expect(afterResetResult).toBe('ok');

    unmount();
  });

  it('allows exactly MAX_TOOL_CALLS_PER_CONVERSATION calls before blocking', async () => {
    const { result, unmount } = renderHook({ conversationId: 'conv-1' });
    await waitForTools(result);

    const tool = result.current.tools['mcp_fake_tool'];

    // Call exactly the limit — all should succeed
    let lastResult: unknown;
    for (let i = 0; i < MAX_TOOL_CALLS_PER_CONVERSATION; i++) {
      lastResult = await tool!.execute!({}, undefined as never);
    }
    expect(lastResult).toBe('ok');

    // One more — should be blocked
    const blockedResult = await tool!.execute!({}, undefined as never);
    expect(blockedResult).toMatchObject({ isError: true });

    unmount();
  });
});
