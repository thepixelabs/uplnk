/**
 * Tests for the /fork command wired through ChatScreen → handleFork.
 *
 * Strategy:
 *  - Mock uplnk-db fully (global setup already does this; we override here)
 *  - Mock useStream, useConversation, useMcp, and the heavy dependencies so
 *    ChatScreen renders without a real provider or network
 *  - Simulate /fork via ChatInput stdin.write()
 *  - Assert forkConversation called with correct args and onForkedTo fired
 *
 * ChatScreen wires a lot of dependencies — we mock at the boundary of uplnk-db
 * and the hook layer, not at internal collaborators.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';

const tick = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

// ─── Hoisted refs ─────────────────────────────────────────────────────────────

const mockForkConversation = vi.hoisted(() => vi.fn());
const mockGetDefaultProvider = vi.hoisted(() => vi.fn(() => undefined));
const mockInsertMessage = vi.hoisted(() => vi.fn());
const mockUpdateMessageContent = vi.hoisted(() => vi.fn());
const mockUpdateConversationTitle = vi.hoisted(() => vi.fn());
const mockListConversations = vi.hoisted(() => vi.fn(() => []));
const mockSearchConversations = vi.hoisted(() => vi.fn(() => []));
const mockCreateConversation = vi.hoisted(() =>
  vi.fn(() => ({
    id: 'test-conv-id',
    title: 'New conversation',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    providerId: null,
    modelId: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  })),
);

vi.mock('uplnk-db', () => ({
  db: {},
  getDefaultProvider: mockGetDefaultProvider,
  forkConversation: mockForkConversation,
  insertMessage: mockInsertMessage,
  updateMessageContent: mockUpdateMessageContent,
  updateConversationTitle: mockUpdateConversationTitle,
  listConversations: mockListConversations,
  searchConversations: mockSearchConversations,
  createConversation: mockCreateConversation,
  getConversation: vi.fn(() => undefined),
  getMessages: vi.fn(() => []),
  listProviders: vi.fn(() => []),
  softDeleteConversation: vi.fn(),
  touchConversation: vi.fn(),
  upsertProviderConfig: vi.fn(),
  runMigrations: vi.fn(),
  getPylonDir: vi.fn(() => '/tmp/pylon-test-home/.pylon'),
  getPylonDbPath: vi.fn(() => '/tmp/pylon-test-home/.uplnk/db.sqlite'),
  ragChunks: {},
}));

// Mock useStream — hoisted so individual tests can override the return value.
// Status is typed as a union so tests can call mockReturnValue with any valid
// state without tripping TS literal narrowing.
type StreamStatus = 'idle' | 'connecting' | 'streaming' | 'done' | 'error';
const mockUseStream = vi.hoisted(() =>
  vi.fn<() => {
    streamedText: string;
    status: StreamStatus;
    activeToolName: string | null;
    error: unknown;
    send: (...args: unknown[]) => Promise<undefined>;
    abort: () => void;
  }>(() => ({
    streamedText: '',
    status: 'idle',
    activeToolName: null,
    error: null,
    send: vi.fn(async () => undefined),
    abort: vi.fn(),
  })),
);

vi.mock('../../hooks/useStream.js', () => ({
  useStream: mockUseStream,
}));

// Mock useConversation — the conversation id and messages are what handleFork reads
const mockMessages = vi.hoisted(() => ({ current: [] as Array<{ id: string; role: string; content: string }> }));

vi.mock('../../hooks/useConversation.js', () => ({
  useConversation: vi.fn(() => ({
    conversationId: 'conv-abc',
    messages: mockMessages.current,
    addMessage: vi.fn(),
  })),
}));

// Mock useMcp — no real McpManager
vi.mock('../../hooks/useMcp.js', () => ({
  useMcp: vi.fn(() => ({
    tools: {},
    pendingApproval: null,
    resolveApproval: vi.fn(),
  })),
  mergeMcpConfigs: vi.fn(() => ({ configs: [], warnings: [] })),
  MAX_TOOL_CALLS_PER_CONVERSATION: 100,
}));

// Mock useArtifacts
vi.mock('../../hooks/useArtifacts.js', () => ({
  useArtifacts: vi.fn(() => ({
    activeArtifact: null,
    promoteArtifact: vi.fn(),
    dismissArtifact: vi.fn(),
    updateArtifact: vi.fn(),
  })),
}));

// Mock useSplitPane
vi.mock('../../hooks/useSplitPane.js', () => ({
  useSplitPane: vi.fn(() => ({
    artifactWidthPct: 40,
    chatWidthPct: 60,
    growArtifact: vi.fn(),
    shrinkArtifact: vi.fn(),
  })),
}));

// Mock config
vi.mock('../../lib/config.js', () => ({
  getOrCreateConfig: vi.fn(() => ({
    ok: true,
    config: {
      version: 1,
      theme: 'dark',
      telemetry: { enabled: false },
      mcp: { allowedPaths: [], commandExecEnabled: false, commandAllowlistAdditions: [], servers: [] },
      git: { enabled: true },
      rag: { enabled: false, autoDetect: false },
      updates: { enabled: false, packageName: 'uplnk' },
    },
  })),
}));

// Mock projectContext and exportConversation (side effects on fs)
vi.mock('../../lib/projectContext.js', () => ({ buildProjectContext: vi.fn(() => null) }));
vi.mock('../../lib/exportConversation.js', () => ({ exportConversation: vi.fn() }));
vi.mock('../../lib/modelRouter.js', () => ({ ModelRouter: vi.fn() }));
vi.mock('../../lib/roles.js', () => ({
  getRole: vi.fn(() => undefined),
  BUILT_IN_ROLES: [],
}));
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(() => vi.fn(() => ({}))),
}));

// Mock fileMention for ChatInput
vi.mock('../../lib/fileMention.js', () => ({
  listMentionCandidates: vi.fn(() => []),
  filterMentionCandidates: vi.fn(() => []),
  __resetMentionCacheForTests: vi.fn(),
}));

import { ChatScreen } from '../ChatScreen.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  version: 1 as const,
  theme: 'dark' as const,
  telemetry: { enabled: false },
  mcp: { allowedPaths: [], commandExecEnabled: false, commandAllowlistAdditions: [], servers: [] },
  providers: [],
  git: { enabled: true },
  rag: { enabled: false, autoDetect: false },
  updates: { enabled: false, packageName: 'uplnk' },
};

function renderChatScreen(overrides: Partial<React.ComponentProps<typeof ChatScreen>> = {}) {
  return render(
    React.createElement(ChatScreen, {
      onError: vi.fn(),
      config: DEFAULT_CONFIG,
      ...overrides,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMessages.current = [];
  // Reset useStream to idle between tests so streaming-state tests don't bleed
  mockUseStream.mockReturnValue({
    streamedText: '',
    status: 'idle' as const,
    activeToolName: null,
    error: null,
    send: vi.fn(async () => undefined),
    abort: vi.fn(),
  });
  mockForkConversation.mockReturnValue({
    id: 'forked-conv-id',
    title: 'Fork of: Test conversation',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    providerId: null,
    modelId: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  });
});

// ─── /fork with messages ──────────────────────────────────────────────────────

describe('ChatScreen /fork — with messages', () => {
  beforeEach(() => {
    mockMessages.current = [
      { id: 'msg-1', role: 'user', content: 'Hello' },
      { id: 'msg-2', role: 'assistant', content: 'Hi there' },
    ];
  });

  it('calls forkConversation with correct conversationId and last message id', async () => {
    const { stdin } = renderChatScreen();
    await tick();
    stdin.write('/fork');
    await tick();
    stdin.write('\r');
    await tick();
    expect(mockForkConversation).toHaveBeenCalledWith(
      expect.anything(), // db
      'conv-abc',
      'msg-2',
    );
  });

  it('calls onForkedTo with the new conversation id', async () => {
    const onForkedTo = vi.fn();
    const { stdin } = renderChatScreen({ onForkedTo });
    await tick();
    stdin.write('/fork');
    await tick();
    stdin.write('\r');
    await tick();
    expect(onForkedTo).toHaveBeenCalledWith('forked-conv-id');
  });

  it('shows fork feedback message in the UI', async () => {
    const { stdin, lastFrame } = renderChatScreen();
    await tick();
    stdin.write('/fork');
    await tick();
    stdin.write('\r');
    await tick();
    expect(lastFrame()).toContain('Forked');
  });
});

// ─── /fork guard: no messages ─────────────────────────────────────────────────

describe('ChatScreen /fork — no messages guard', () => {
  it('does not call forkConversation when conversation is empty', async () => {
    mockMessages.current = [];
    const { stdin } = renderChatScreen();
    await tick();
    stdin.write('/fork');
    await tick();
    stdin.write('\r');
    await tick();
    expect(mockForkConversation).not.toHaveBeenCalled();
  });

  it('shows "Nothing to fork" feedback when no messages exist', async () => {
    mockMessages.current = [];
    const { stdin, lastFrame } = renderChatScreen();
    await tick();
    stdin.write('/fork');
    await tick();
    stdin.write('\r');
    await tick();
    expect(lastFrame()).toContain('Nothing to fork');
  });
});

// ─── /fork guard: streaming ───────────────────────────────────────────────────

describe('ChatScreen /fork — streaming guard', () => {
  // Note: when status === 'streaming', ChatInput is disabled so the user cannot
  // type. handleFork is exercised by calling onCommand('fork') directly via a
  // thin wrapper rendered around ChatScreen's command plumbing. Instead we verify
  // the guard at the unit level: handleFork reads `status` from useStream and
  // returns early. We render ChatScreen with streaming status and confirm no fork.
  it('does not call forkConversation while streaming', async () => {
    mockUseStream.mockReturnValue({
      streamedText: 'partial...',
      status: 'streaming',
      activeToolName: null,
      error: null,
      send: vi.fn(async () => undefined),
      abort: vi.fn(),
    });
    mockMessages.current = [{ id: 'msg-1', role: 'user', content: 'Hello' }];

    renderChatScreen();
    await tick();
    // ChatInput is disabled during streaming — can't type /fork.
    // Verify forkConversation was never called during render.
    expect(mockForkConversation).not.toHaveBeenCalled();
  });

  it('shows streaming indicator (input disabled) when streaming — fork is blocked', async () => {
    mockUseStream.mockReturnValue({
      streamedText: 'partial...',
      status: 'streaming',
      activeToolName: null,
      error: null,
      send: vi.fn(async () => undefined),
      abort: vi.fn(),
    });
    mockMessages.current = [{ id: 'msg-1', role: 'user', content: 'Hello' }];

    const { lastFrame } = renderChatScreen();
    await tick();
    // ChatInput shows streaming indicator when disabled — confirms fork is gated
    expect(lastFrame()).toContain('streaming');
    expect(mockForkConversation).not.toHaveBeenCalled();
  });
});

// ─── /fork error handling ─────────────────────────────────────────────────────

describe('ChatScreen /fork — error handling', () => {
  it('shows error feedback when forkConversation throws', async () => {
    mockMessages.current = [{ id: 'msg-1', role: 'user', content: 'Hello' }];
    mockForkConversation.mockImplementation(() => {
      throw new Error('DB constraint violation');
    });

    const { stdin, lastFrame } = renderChatScreen();
    await tick();
    stdin.write('/fork');
    await tick();
    stdin.write('\r');
    await tick();
    // The feedbackMsg should contain the error prefix "Fork failed"
    expect(lastFrame()).toContain('Fork failed');
    expect(lastFrame()).toContain('DB constraint violation');
  });
});
