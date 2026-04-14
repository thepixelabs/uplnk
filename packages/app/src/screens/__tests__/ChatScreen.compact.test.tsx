/**
 * Tests for the /compact command wired through ChatScreen.
 *
 * Strategy mirrors ChatScreen.fork.test.tsx:
 *  - Mock @uplnk/db, hooks, and heavy dependencies
 *  - Mock the compactConversation lib so we can drive success / failure
 *    without a real model
 *  - Drive /compact via ChatInput stdin.write()
 *  - Assert the lib was called with the right messages and that on failure
 *    the conversation is unchanged (replaceWithSummary NOT called).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';

const tick = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mockGetDefaultProvider = vi.hoisted(() => vi.fn(() => undefined));
const mockInsertMessage = vi.hoisted(() => vi.fn());
const mockUpdateMessageContent = vi.hoisted(() => vi.fn());
const mockUpdateConversationTitle = vi.hoisted(() => vi.fn());
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
const mockDeleteMessage = vi.hoisted(() => vi.fn());

vi.mock('@uplnk/db', () => ({
  db: {},
  getDefaultProvider: mockGetDefaultProvider,
  forkConversation: vi.fn(),
  insertMessage: mockInsertMessage,
  updateMessageContent: mockUpdateMessageContent,
  updateConversationTitle: mockUpdateConversationTitle,
  listConversations: vi.fn(() => []),
  searchConversations: vi.fn(() => []),
  createConversation: mockCreateConversation,
  getConversation: vi.fn(() => undefined),
  getMessages: vi.fn(() => []),
  listProviders: vi.fn(() => []),
  softDeleteConversation: vi.fn(),
  touchConversation: vi.fn(),
  deleteMessage: mockDeleteMessage,
  upsertProviderConfig: vi.fn(),
  runMigrations: vi.fn(),
  getUplnkDir: vi.fn(() => '/tmp/uplnk-test-home/.uplnk'),
  getUplnkDbPath: vi.fn(() => '/tmp/uplnk-test-home/.uplnk/db.sqlite'),
  ragChunks: {},
}));

type StreamStatus = 'idle' | 'connecting' | 'streaming' | 'done' | 'error';
const mockUseStream = vi.hoisted(() =>
  vi.fn<() => {
    streamedTextRef: React.MutableRefObject<string>;
    subscribeToStreamText: (cb: () => void) => () => void;
    status: StreamStatus;
    activeToolName: string | null;
    error: unknown;
    send: (...args: unknown[]) => Promise<undefined>;
    abort: () => void;
  }>(() => ({
    streamedTextRef: { current: '' },
    subscribeToStreamText: vi.fn(() => vi.fn()),
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

vi.mock('../../components/voice/VoiceAssistantProvider.js', () => ({
  useVoiceAssistant: vi.fn(() => ({
    isInitialized: false,
    isDictating: false,
    partialTranscription: '',
    startDictation: vi.fn(),
    stopDictation: vi.fn(),
    toggleDictation: vi.fn(),
    registerTranscriptionHandler: vi.fn(() => vi.fn()),
    error: null,
    statusMessage: null,
  })),
  VoiceAssistantProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// useConversation mock — the only piece of state that matters is `messages`
// and `replaceWithSummary`, which we spy on to verify mutation behaviour.
const mockMessages = vi.hoisted(() => ({
  current: [] as Array<{ id: string; role: string; content: string }>,
}));
const mockReplaceWithSummary = vi.hoisted(() => vi.fn());

vi.mock('../../hooks/useConversation.js', () => ({
  useConversation: vi.fn(() => ({
    conversationId: 'conv-compact',
    messages: mockMessages.current,
    addMessage: vi.fn(),
    appendAssistantToState: vi.fn(),
    replaceWithSummary: mockReplaceWithSummary,
  })),
}));

vi.mock('../../hooks/useMcp.js', () => ({
  useMcp: vi.fn(() => ({
    tools: {},
    pendingApproval: null,
    resolveApproval: vi.fn(),
  })),
  mergeMcpConfigs: vi.fn(() => ({ configs: [], warnings: [] })),
  MAX_TOOL_CALLS_PER_CONVERSATION: 100,
}));

vi.mock('../../hooks/useProviderConnectivity.js', () => ({
  useProviderConnectivity: vi.fn(() => ({
    host: 'localhost:11434',
    connected: true,
    checkedAt: Date.now(),
    latencyMs: 25,
    disconnectedSince: null,
    errorDetail: null,
  })),
}));

vi.mock('../../hooks/useArtifacts.js', () => ({
  useArtifacts: vi.fn(() => ({
    activeArtifact: null,
    promoteArtifact: vi.fn(),
    dismissArtifact: vi.fn(),
    updateArtifact: vi.fn(),
  })),
}));

vi.mock('../../hooks/useSplitPane.js', () => ({
  useSplitPane: vi.fn(() => ({
    artifactWidthPct: 40,
    chatWidthPct: 60,
    growArtifact: vi.fn(),
    shrinkArtifact: vi.fn(),
  })),
}));

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

vi.mock('../../lib/projectContext.js', () => ({ buildProjectContext: vi.fn(() => null) }));
vi.mock('../../lib/exportConversation.js', () => ({ exportConversation: vi.fn() }));
vi.mock('../../lib/modelRouter.js', () => ({ ModelRouter: vi.fn() }));
vi.mock('../../lib/roles.js', () => ({
  getRole: vi.fn(() => undefined),
  BUILT_IN_ROLES: [],
}));
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(() => vi.fn(() => ({ __stub: 'active-model' }))),
}));
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn(() => ({ __stub: 'active-model' }))),
}));

vi.mock('../../lib/fileMention.js', () => ({
  listMentionCandidates: vi.fn(() => []),
  filterMentionCandidates: vi.fn(() => []),
  __resetMentionCacheForTests: vi.fn(),
}));

vi.mock('../../components/voice/VoiceAssistantProvider.js', () => ({
  VoiceAssistantProvider: ({ children }: { children: React.ReactNode }) => children,
  useVoiceAssistant: vi.fn(() => ({
    isInitialized: false,
    isDictating: false,
    partialTranscription: '',
    startDictation: vi.fn(),
    stopDictation: vi.fn(),
    toggleDictation: vi.fn(),
    registerTranscriptionHandler: vi.fn(() => vi.fn()),
    error: null,
    statusMessage: null,
  })),
}));

// Mock the compact lib so we can drive success/failure without a model call.
// We hand-roll the whole module (no importActual) to keep the factory sync
// and avoid races with vi.hoisted + top-level await.
const mockSummariseMessages = vi.hoisted(() => vi.fn());
vi.mock('../../lib/compactConversation.js', () => ({
  COMPACT_KEEP_TAIL: 6,
  COMPACT_MIN_MESSAGES: 8,
  formatSummaryContent: (s: string) => `[\u2211 Summary: ${s.trim()}]`,
  splitForCompaction: (messages: Array<{ id: string }>, keepTail = 6) => {
    if (messages.length <= keepTail) return { toSummarise: [], toKeep: [...messages] };
    const cut = messages.length - keepTail;
    return { toSummarise: messages.slice(0, cut), toKeep: messages.slice(cut) };
  },
  summariseMessages: mockSummariseMessages,
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
  relayMode: { enabled: false },
  networkScanner: { timeoutMs: 2000, concurrency: 16 },
};

function renderChatScreen(
  overrides: Partial<React.ComponentProps<typeof ChatScreen>> = {},
) {
  return render(
    React.createElement(ChatScreen, {
      onError: vi.fn(),
      config: DEFAULT_CONFIG,
      ...overrides,
    }),
  );
}

function makeMsg(i: number, role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant') {
  return { id: `m${i}`, role, content: `body ${i}` };
}

async function sendCompact(stdin: { write: (s: string) => void }) {
  stdin.write('/compact');
  await tick();
  stdin.write('\r');
  // /compact kicks off an async generateText; give the microtask queue a
  // couple of flushes so the handler's try/catch can run to completion.
  await tick();
  await tick();
  await tick();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMessages.current = [];
  mockReplaceWithSummary.mockReset();
  mockSummariseMessages.mockReset();
  mockUseStream.mockReturnValue({
    streamedTextRef: { current: '' },
    subscribeToStreamText: vi.fn(() => vi.fn()),
    status: 'idle' as const,
    activeToolName: null,
    error: null,
    send: vi.fn(async () => undefined),
    abort: vi.fn(),
  });
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('ChatScreen /compact — success', () => {
  beforeEach(() => {
    // 10 messages — keepTail=6, so 4 will be summarised.
    mockMessages.current = Array.from({ length: 10 }, (_, i) => makeMsg(i));
    mockSummariseMessages.mockResolvedValue('a tidy summary');
  });

  it('calls summariseMessages with the 4 oldest messages', async () => {
    const { stdin } = renderChatScreen();
    await tick();
    await sendCompact(stdin);

    expect(mockSummariseMessages).toHaveBeenCalledTimes(1);
    const [, targets] = mockSummariseMessages.mock.calls[0]!;
    const ids = (targets as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toEqual(['m0', 'm1', 'm2', 'm3']);
  });

  it('replaces summarised messages with a single synthetic summary', async () => {
    const { stdin } = renderChatScreen();
    await tick();
    await sendCompact(stdin);

    expect(mockReplaceWithSummary).toHaveBeenCalledTimes(1);
    const [idsToRemove, summaryContent] = mockReplaceWithSummary.mock.calls[0]!;
    expect(idsToRemove).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(summaryContent).toContain('a tidy summary');
    // Visual marker present so users can spot it in the message list.
    expect(summaryContent).toContain('Summary:');
  });

  it('shows the confirmation feedback in the UI', async () => {
    const { stdin, lastFrame } = renderChatScreen();
    await tick();
    await sendCompact(stdin);
    expect(lastFrame()).toContain('Compacted 4 messages');
    expect(lastFrame()).toContain('Context freed');
  });
});

// ─── Failure leaves state untouched ───────────────────────────────────────────

describe('ChatScreen /compact — provider failure', () => {
  beforeEach(() => {
    mockMessages.current = Array.from({ length: 10 }, (_, i) => makeMsg(i));
    mockSummariseMessages.mockRejectedValue(new Error('provider exploded'));
  });

  it('does NOT call replaceWithSummary when the summariser throws', async () => {
    const { stdin } = renderChatScreen();
    await tick();
    await sendCompact(stdin);
    expect(mockSummariseMessages).toHaveBeenCalledTimes(1);
    expect(mockReplaceWithSummary).not.toHaveBeenCalled();
  });

  it('surfaces the error as a feedback message', async () => {
    const { stdin, lastFrame } = renderChatScreen();
    await tick();
    await sendCompact(stdin);
    expect(lastFrame()).toContain('Compact failed');
    expect(lastFrame()).toContain('provider exploded');
  });
});

// ─── Nothing-to-compact guard ─────────────────────────────────────────────────

describe('ChatScreen /compact — below minimum', () => {
  it('shows "Nothing to compact yet." and does not call the summariser', async () => {
    mockMessages.current = Array.from({ length: 4 }, (_, i) => makeMsg(i));
    const { stdin, lastFrame } = renderChatScreen();
    await tick();
    await sendCompact(stdin);
    expect(mockSummariseMessages).not.toHaveBeenCalled();
    expect(mockReplaceWithSummary).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('Nothing to compact yet');
  });
});
