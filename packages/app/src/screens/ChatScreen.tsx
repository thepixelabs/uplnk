import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { writeFile } from 'node:fs/promises';
import clipboard from 'clipboardy';
import type { CoreMessage, LanguageModel } from 'ai';
import type { AuthMode } from '@uplnk/providers';
import { resolveCapabilities } from '@uplnk/catalog';
import type { CatalogProviderKind } from '@uplnk/catalog';
import { createLanguageModel } from '../lib/languageModelFactory.js';
import { db, getConversation, getDefaultProvider, insertMessage, updateMessageContent, forkConversation, updateConversationTitle } from '@uplnk/db';
import { resolveSecret } from '../lib/secrets.js';
import { useStream } from '../hooks/useStream.js';
import { useConversation } from '../hooks/useConversation.js';
import { useArtifacts } from '../hooks/useArtifacts.js';
import { useMcp } from '../hooks/useMcp.js';
import { useProviderConnectivity } from '../hooks/useProviderConnectivity.js';
import { useSplitPane } from '../hooks/useSplitPane.js';
import { getOrCreateConfig } from '../lib/config.js';
import type { Config } from '../lib/config.js';
import { ModelRouter } from '../lib/modelRouter.js';
import { buildProjectContext } from '../lib/projectContext.js';
import { exportConversation } from '../lib/exportConversation.js';
import {
  splitForCompaction,
  summariseMessages,
  formatSummaryContent,
  COMPACT_MIN_MESSAGES,
} from '../lib/compactConversation.js';
import { getRole } from '../lib/roles.js';
import {
  extractMentions,
  formatAttachmentsForContext,
  parseAgentMention,
} from '../lib/agents/parseUserInput.js';
import { getAgentRegistry } from '../lib/agents/registry.js';
import { AgentOrchestrator } from '../lib/agents/orchestrator.js';
import { getGlobalAgentEventBus } from '../lib/agents/eventBus.js';
import { useAgentRun } from '../hooks/useAgentRun.js';
import { useRoomRun } from '../hooks/useRoomRun.js';
import { EphemeralRegistry } from '../lib/agents/ephemeralRegistry.js';
import { AgentEventView } from '../components/chat/AgentEventView.js';
import { MessageList } from '../components/chat/MessageList.js';
import {
  buildLineIndex,
  windowByLineOffset,
  messageStartLine,
  totalLines,
} from '../lib/messageLines.js';
import { ChatInput } from '../components/chat/ChatInput.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { StreamingTextOverlay } from '../components/chat/StreamingTextOverlay.js';
import { Header } from '../components/layout/Header.js';
import { ArtifactPanel } from '../components/artifacts/ArtifactPanel.js';
import { ApprovalDialog } from '../components/mcp/ApprovalDialog.js';
import type { UplnkError } from '@uplnk/shared';
import { toUplnkError } from '../lib/errors.js';
import {
  buildProviderConnectionDisplay,
  inferProviderAuthMode,
} from '../lib/providerConnectivity.js';
import { VERSION } from '../lib/version.js';

interface Props {
  initialModel?: string;
  resumeConversationId?: string;
  projectDir?: string;
  overrideBaseUrl?: string;
  overrideApiKey?: string;
  overrideProviderType?: string;
  overrideAuthMode?: AuthMode;
  config?: Config;
  onNavigate?: (screen: string) => void;
  onError: (error: UplnkError) => void;
  onCommand?: (command: string) => void;
  /**
   * Fired after a /fork creates a new conversation. App reacts by remounting
   * ChatScreen with the forked id so streaming state and message history
   * reset cleanly.
   */
  onForkedTo?: (newConversationId: string) => void;
}

const HEADER_HEIGHT = 6; // Outer border plus two inner metadata rows
const CHAT_INPUT_HEIGHT = 5; // Fixed height ChatInput area

const DEFAULT_CONFIG: Config = {
  version: 1,
  theme: 'dark',
  telemetry: { enabled: false },
  mcp: { allowedPaths: [], commandExecEnabled: false, commandAllowlistAdditions: [], servers: [] },
  providers: [],
  git: { enabled: true },
  rag: { enabled: false, autoDetect: false },
  updates: { enabled: true, packageName: 'uplnk' },
  // modelRouter is intentionally absent — defaults to disabled
  relayMode: { enabled: false },
  networkScanner: { timeoutMs: 2000, concurrency: 16 },
  headless: { persist: false },
  flows: { dir: '~/.uplnk/flows', autoReload: true, defaultTimeoutMs: 600000, allowShellStep: false, allowHttpStep: true, httpAllowlist: [], concurrency: 1 },
  robotic: { enabled: false, transport: 'auto', maxTurns: 40, turnTimeoutMs: 120000, minInterTurnMs: 750, judge: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', everyNTurns: 1 }, redact: { envPatterns: ['(?i)api[_-]?key', '(?i)token', '(?i)secret', '(?i)password'], customPatterns: [] }, targets: {} },
  altergo: { binary: 'altergo', home: '~/.altergo', autoImport: false, autoImportAccounts: [], watchSessions: false, launchDetach: true },
};

export function ChatScreen({
  initialModel,
  resumeConversationId,
  projectDir,
  overrideBaseUrl,
  overrideApiKey,
  overrideProviderType,
  overrideAuthMode,
  config: configProp,
  onError,
  onCommand,
  onForkedTo,
}: Props) {
  const { exit } = useApp();

  // Use config passed from bin/uplnk.ts. Falls back to getOrCreateConfig() for
  // non-CLI entry points (tests, Storybook). In production the config is always
  // provided — bin/uplnk.ts exits early if it's invalid.
  const configRef = useRef<Config | null>(null);
  if (configRef.current === null) {
    if (configProp !== undefined) {
      configRef.current = configProp;
    } else {
      const configResult = getOrCreateConfig();
      configRef.current = configResult.ok ? configResult.config : DEFAULT_CONFIG;
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const config = configRef.current!;

  // Provider settings — loaded once via ref, but overrides from props take priority.
  // `apiKey` from the DB column may be a `@secret:` ref (resolved via the
  // secrets backend) or legacy plaintext — `resolveSecret` handles both.
  const providerRef = useRef<{ baseURL: string; apiKey: string; defaultModel: string; providerType: string; authMode: AuthMode } | null>(null);
  if (providerRef.current === null) {
    const row = getDefaultProvider(db);
    const resolvedKey = overrideApiKey ?? resolveSecret(row?.apiKey) ?? 'ollama';
    const providerType = overrideProviderType ?? row?.providerType ?? 'ollama';
    providerRef.current = {
      baseURL: overrideBaseUrl ?? row?.baseUrl ?? 'http://localhost:11434/v1',
      apiKey: resolvedKey,
      defaultModel: row?.defaultModel ?? config.defaultModel ?? 'llama3.2',
      providerType,
      authMode: overrideAuthMode ?? (row?.authMode as AuthMode | undefined) ?? inferProviderAuthMode(providerType),
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const { baseURL, apiKey, defaultModel, providerType, authMode } = providerRef.current!;

  const resolvedModel = initialModel ?? defaultModel;

  const activeModel = useMemo(() => {
    return createLanguageModel({ providerType, baseURL, apiKey, modelId: resolvedModel });
  }, [providerType, baseURL, apiKey, resolvedModel]);

  // Model router — created once; null when routing is disabled
  const modelRouterRef = useRef<ModelRouter | null>(null);
  if (modelRouterRef.current === null && config.modelRouter?.enabled === true) {
    modelRouterRef.current = new ModelRouter({
      enabled: true,
      defaultModel: resolvedModel,
      routes: config.modelRouter.routes,
    });
  }
  const modelRouter = modelRouterRef.current;

  // When the router is active, display "(router)" in the header so the user
  // can see that automatic model selection is in effect.
  const routerActive = modelRouter !== null;

  // Conversation must come before useMcp so conversationId is available for
  // BC-5 rate limiting (tool call counter resets on new conversation).
  const { conversationId, messages, addMessage, appendAssistantToState, replaceWithSummary } = useConversation(resumeConversationId);
  const [conversationTitle, setConversationTitle] = useState(() =>
    resumeConversationId !== undefined
      ? getConversation(db, resumeConversationId)?.title ?? 'New conversation'
      : 'New conversation',
  );

  // MCP tools (file-browse + git always on; command-exec feature-flagged)
  // BC-3: pass commandExecConfirmedAt so useMcp can enforce the double-check.
  // BC-5: pass conversationId so useMcp can reset the rate-limit counter on new conversations.
  // Normalise Zod-parsed mcp.servers into McpServerConfig. Zod produces
  // `env?: Record<string,string> | undefined`, McpServerConfig wants
  // `env?: Record<string,string>` — under `exactOptionalPropertyTypes` the
  // two aren't assignable without stripping `undefined` fields first.
  const normalizedConfigServers = useMemo(() => {
    return config.mcp.servers.map((s) => {
      if (s.type === 'stdio') {
        return {
          id: s.id,
          name: s.name,
          type: 'stdio' as const,
          command: s.command,
          args: s.args,
          ...(s.env !== undefined ? { env: s.env } : {}),
        };
      }
      return {
        id: s.id,
        name: s.name,
        type: 'http' as const,
        url: s.url,
      };
    });
  }, [config.mcp.servers]);

  const { tools: mcpTools, pendingApproval, resolveApproval } = useMcp({
    allowedPaths: config.mcp.allowedPaths,
    commandExecEnabled: config.mcp.commandExecEnabled,
    ...(config.mcp.commandExecConfirmedAt !== undefined
      ? { commandExecConfirmedAt: config.mcp.commandExecConfirmedAt }
      : {}),
    gitEnabled: config.git.enabled,
    ragEnabled: config.rag.enabled,
    ...(config.rag.embed !== undefined ? { ragEmbedConfig: config.rag.embed } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
    configServers: normalizedConfigServers,
  });

  // ─── Agent system ────────────────────────────────────────────────────────────
  const agentRegistry = useMemo(
    () => getAgentRegistry(projectDir !== undefined ? { projectDir } : undefined),
    [projectDir],
  );
  const agentEventBus = useMemo(() => getGlobalAgentEventBus(), []);
  const agentOrchestrator = useMemo(
    () =>
      new AgentOrchestrator({
        registry: agentRegistry,
        modelFactory: (spec) =>
          spec.model === 'inherit' || spec.model === undefined
            ? activeModel
            : createLanguageModel({ providerType, baseURL, apiKey, modelId: spec.model }),
        rootTools: mcpTools,
        eventBus: agentEventBus,
      }),
    [agentRegistry, agentEventBus, activeModel, providerType, baseURL, apiKey, mcpTools],
  );
  const agentRun = useAgentRun({ orchestrator: agentOrchestrator, eventBus: agentEventBus });

  // Ephemeral registry: layers spawn_agent-created agents on top of the base
  // disk registry for the current conversation. Re-instantiated whenever the
  // conversation id changes (i.e. user starts/resumes a different chat).
  const roomRegistry = useMemo(
    () => new EphemeralRegistry({ base: agentRegistry, conversationId }),
    [agentRegistry, conversationId],
  );

  // Effective tool names in the chat — cached stably so the room hook's
  // callback identity doesn't churn per render.
  const effectiveToolNames = useMemo(
    () => new Set(Object.keys(mcpTools)),
    [mcpTools],
  );

  const roomRun = useRoomRun({
    orchestrator: agentOrchestrator,
    eventBus: agentEventBus,
    registry: roomRegistry,
    conversationId,
    effectiveToolNames,
  });

  // Build project context once at mount — used as a system message prefix
  const projectContextRef = useRef<string | null>(null);
  if (projectContextRef.current === null && projectDir !== undefined) {
    const ctx = buildProjectContext(projectDir);
    projectContextRef.current = ctx?.systemPrompt ?? null;
  }

  const { streamedTextRef, subscribeToStreamText, status, error, sessionTokens, send, abort } = useStream(activeModel);
  const connectionState = useProviderConnectivity({ providerType, baseURL, apiKey, authMode });
  const { activeArtifact, promoteArtifact, dismissArtifact, updateArtifact } = useArtifacts();
  const { artifactWidthPct, chatWidthPct, growArtifact, shrinkArtifact } = useSplitPane();
  const { columns: termCols, rows: termRows } = useTerminalSize();
  const prevStatusRef = useRef(status);
  const currentDirectory = projectDir ?? process.cwd();
  const connectionDisplay = buildProviderConnectionDisplay(connectionState);

  // Active role (null = no role)
  const [activeRole, setActiveRole] = useState<string | null>(null);
  // Transient feedback message (export confirmation, role applied, etc.)
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);
  // Help panel visibility (toggled by /help)
  const [showHelp, setShowHelp] = useState(false);

  // ─── Scrollback state ──────────────────────────────────────────────────────
  // `scrollTopLine` is the line index (from the top of the full transcript)
  // that should appear at the top of the viewport. 0 means "pinned to the
  // bottom / live mode" — same semantics as the existing <Static> renderer.
  const [scrollTopLine, setScrollTopLine] = useState(0);
  const inScrollback = scrollTopLine > 0;

  const [forkCursorIdx, setForkCursorIdx] = useState<number | null>(null);
  const inForkCursor = forkCursorIdx !== null;

  // Effective chat pane columns (accounting for split pane with artifact).
  const chatCols = activeArtifact !== null
    ? Math.max(20, Math.floor((termCols * chatWidthPct) / 100) - 2)
    : Math.max(20, termCols - 2);

  // Fixed reservation height (Header + StatusBar + ChatInput + feedback area + scroll indicator)
  const CHROME_HEIGHT =
    HEADER_HEIGHT +
    CHAT_INPUT_HEIGHT +
    (feedbackMsg !== null ? 1 : 0) +
    (activeRole !== null ? 1 : 0) +
    (inScrollback ? 3 : 0) +
    (inForkCursor ? 3 : 0);
  const viewportLines = Math.max(5, termRows - CHROME_HEIGHT);

  const lineIndex = useMemo(
    () => buildLineIndex(messages, chatCols),
    [messages, chatCols],
  );
  const totalContentLines = totalLines(lineIndex);

  // Visible slice for the current scroll position.
  const { startIdx: scrollStartIdx, endIdx: scrollEndIdx } = useMemo(() => {
    const targetLine = inScrollback ? scrollTopLine : Math.max(0, totalContentLines - viewportLines);
    return windowByLineOffset(lineIndex, targetLine, viewportLines);
  }, [lineIndex, scrollTopLine, viewportLines, totalContentLines, inScrollback]);

  // When new messages arrive or streaming starts, drop back to live mode.
  const lastMessageCountRef = useRef(messages.length);
  useEffect(() => {
    if (messages.length !== lastMessageCountRef.current) {
      lastMessageCountRef.current = messages.length;
      setScrollTopLine(0);
    }
  }, [messages.length]);
  useEffect(() => {
    if (status === 'streaming' || status === 'connecting') {
      setScrollTopLine(0);
    }
  }, [status]);

  // Clamp forkCursorIdx when messages are removed (e.g. by /compact).
  useEffect(() => {
    if (forkCursorIdx === null) return;
    if (messages.length === 0) {
      setForkCursorIdx(null);
      return;
    }
    if (forkCursorIdx >= messages.length) {
      setForkCursorIdx(messages.length - 1);
    }
  }, [messages.length, forkCursorIdx]);

  // Auto-scroll the fork cursor target into view when it changes.
  useEffect(() => {
    if (forkCursorIdx === null) return;
    const targetLine = messageStartLine(lineIndex, forkCursorIdx);
    if (targetLine === undefined) return;
    const currentTop = scrollTopLine > 0 ? scrollTopLine : Math.max(0, totalContentLines - viewportLines);
    const currentBottom = currentTop + viewportLines;
    if (targetLine >= currentTop && targetLine < currentBottom) return; // already visible
    setScrollTopLine(Math.max(1, targetLine));
  }, [forkCursorIdx, lineIndex, scrollTopLine, totalContentLines, viewportLines]);

  /** Locate the message currently at the top of the viewport. */
  const findCurrentTopMessage = useCallback((): number => {
    if (lineIndex.length === 0) return 0;
    const targetLine = inScrollback ? scrollTopLine : Math.max(0, totalContentLines - viewportLines);
    let top = 0;
    for (let i = 0; i < lineIndex.length; i++) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const start = i === 0 ? 0 : lineIndex[i - 1]!.cumulative;
      if (start >= targetLine) return i;
      top = i;
    }
    return top;
  }, [inScrollback, lineIndex, scrollTopLine, totalContentLines, viewportLines]);

  /** Scroll up by one message */
  const scrollUpOneMessage = useCallback(() => {
    if (lineIndex.length === 0) return;
    const currentTop = findCurrentTopMessage();
    const nextMsg = currentTop - 1;
    if (nextMsg < 0) {
      if (totalContentLines > viewportLines) setScrollTopLine(1);
      return;
    }
    const nextLine = messageStartLine(lineIndex, nextMsg + 1);
    setScrollTopLine(Math.max(1, nextLine));
  }, [findCurrentTopMessage, lineIndex, totalContentLines, viewportLines]);

  /** Scroll down by one message */
  const scrollDownOneMessage = useCallback(() => {
    if (!inScrollback || lineIndex.length === 0) return;
    const currentTop = findCurrentTopMessage();
    const nextMsg = currentTop + 1;
    if (nextMsg >= lineIndex.length) {
      setScrollTopLine(0);
      return;
    }
    const nextLine = messageStartLine(lineIndex, nextMsg + 1);
    if (nextLine >= Math.max(0, totalContentLines - viewportLines)) {
      setScrollTopLine(0);
      return;
    }
    setScrollTopLine(Math.max(1, nextLine));
  }, [findCurrentTopMessage, inScrollback, lineIndex, totalContentLines, viewportLines]);

  // ─── Stream persistence ──────────────────────────────────────────────────
  const assistantMessageIdRef = useRef<string | null>(null);

  // When streaming completes, commit the final text to React state once.
  // During streaming, streamedText is rendered directly via the live assistant
  // overlay below (not through the messages array), so no state update is needed
  // per-token — this eliminates the 33 ms spurious re-renders that were causing
  // the full-screen flicker.
  useEffect(() => {
    if (prevStatusRef.current === 'streaming' && status === 'done') {
      const text = streamedTextRef.current;
      const id = assistantMessageIdRef.current;
      if (id !== null && text) {
        appendAssistantToState(id, text);
      }
      assistantMessageIdRef.current = null;
    }
    prevStatusRef.current = status;
  }, [status, appendAssistantToState]);

  useEffect(() => {
    if (error) onError(error);
  }, [error, onError]);

  // ─── Handlers ────────────────────────────────────────────────────────────
  const [focusedPanel, setFocusedPanel] = useState<'chat' | 'artifact'>('chat');
  const [isCompacting, setIsCompacting] = useState(false);

  const handleDismissArtifact = useCallback(() => {
    dismissArtifact();
    setFocusedPanel('chat');
  }, [dismissArtifact]);

  const handleSaveArtifact = useCallback(async (path: string, content: string) => {
    await writeFile(path, content, 'utf-8');
  }, []);

  const handleCopyArtifact = useCallback(async (content: string) => {
    await clipboard.write(content);
  }, []);

  const handleSubmit = useCallback(
    async (input: string) => {
      if (!input.trim() || status === 'streaming' || agentRun.status === 'running' || roomRun.status === 'running') return;

      // ─── Parse @mentions into a structured payload ─────────────────────────
      // Runs before legacy agent-match so we can harvest file attachments even
      // when routing falls through to the default assistant.
      const payload = projectDir !== undefined
        ? extractMentions(input, agentRegistry, projectDir)
        : { text: input, addressees: [] as string[], attachments: [] as ReturnType<typeof extractMentions>['attachments'] };
      const attachmentsBlock = formatAttachmentsForContext(payload.attachments);

      // ─── Multi-agent room routing (≥1 @agent) ───────────────────────────────
      // When the user addresses one or more registered agents, route through
      // RoomConductor so handoff_to_agent / return_to_user / spawn_agent tools
      // are available and every agent's turn is written to the visible
      // transcript with proper sender attribution.
      if (payload.addressees.length > 0) {
        if (messages.length === 0) {
          const firstLine = input.trim().split(/\r?\n/)[0] ?? input.trim();
          const title = firstLine.slice(0, 60).trim();
          if (title !== '') {
            try {
              updateConversationTitle(db, conversationId, title);
              setConversationTitle(title);
            } catch { /* non-fatal */ }
          }
        }
        addMessage({ role: 'user', content: input });
        const history: CoreMessage[] = [
          ...messages
            .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
            .map((m): CoreMessage => ({
              role: m.role as 'user' | 'assistant' | 'system',
              content: m.content ?? '',
            })),
          ...(attachmentsBlock !== ''
            ? [{ role: 'system', content: attachmentsBlock } as const]
            : []),
        ];
        try {
          await roomRun.start({
            addressees: payload.addressees,
            cc: payload.addressees.slice(1),
            userText: input,
            history,
          });
        } catch {
          // Error already captured on the event bus + useRoomRun state.
        }
        return;
      }

      // ─── Legacy single-addressee fallback ───────────────────────────────────
      const agentMatch = parseAgentMention(input, agentRegistry);
      if (agentMatch !== null) {
        if (messages.length === 0) {
          const firstLine = input.trim().split(/\r?\n/)[0] ?? input.trim();
          const title = firstLine.slice(0, 60).trim();
          if (title !== '') {
            try {
              updateConversationTitle(db, conversationId, title);
              setConversationTitle(title);
            } catch { /* non-fatal */ }
          }
        }
        addMessage({ role: 'user', content: input });
        const history: CoreMessage[] = messages
          .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
          .map((m): CoreMessage => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content ?? '' }));
        try {
          const result = await agentRun.run(agentMatch.agent, agentMatch.prompt, history);
          const agentMsgId = crypto.randomUUID();
          insertMessage(db, { id: agentMsgId, conversationId, role: 'assistant', content: result.finalText });
          appendAssistantToState(agentMsgId, result.finalText);
        } catch {
          // Error already emitted on the event bus and shown in AgentEventView
        }
        return;
      }

      if (messages.length === 0) {
        const firstLine = input.trim().split(/\r?\n/)[0] ?? input.trim();
        const title = firstLine.slice(0, 60).trim();
        if (title !== '') {
          try {
            updateConversationTitle(db, conversationId, title);
            setConversationTitle(title);
          } catch {
            // Non-fatal — title is cosmetic.
          }
        }
      }

      addMessage({ role: 'user', content: input });

      const assistantMsgId = crypto.randomUUID();
      assistantMessageIdRef.current = assistantMsgId;
      
      // DB row pre-inserted above; React state will be updated when streaming completes
      // via appendAssistantToState (using assistantMsgId).

      // Persistence to DB
      insertMessage(db, { id: assistantMsgId, conversationId, role: 'assistant', content: '' });

      const rolePrompt = activeRole !== null ? getRole(activeRole)?.prompt : undefined;
      const hasSystemMessage = messages.some((m) => m.role === 'system');
      // Always include a system prompt. Without one, some local models (e.g. qwen2.5, llama)
      // default to emitting raw tool-call JSON for casual messages instead of responding
      // conversationally. The fallback keeps behaviour predictable when no role/project
      // context is set.
      const FALLBACK_SYSTEM =
        'You are a helpful assistant. Respond conversationally to casual messages. ' +
        'Only use tools when the user\'s request explicitly requires accessing files, ' +
        'running commands, or interacting with the system.';
      const systemContent = !hasSystemMessage
        ? (rolePrompt ?? projectContextRef.current ?? FALLBACK_SYSTEM)
        : null;
      
      const coreMessages: CoreMessage[] = [
        ...(systemContent ? [{ role: 'system', content: systemContent } as const] : []),
        ...messages
          .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
          .map((m): CoreMessage => ({
            role: m.role as 'user' | 'assistant' | 'system',
            content: m.content ?? '',
          })),
        ...(attachmentsBlock !== ''
          ? [{ role: 'system', content: attachmentsBlock } as const]
          : []),
        { role: 'user', content: input },
      ];

      let modelOverride: LanguageModel | undefined;
      let effectiveModelId = resolvedModel;
      if (modelRouter !== null) {
        const turnCount = messages.filter((m) => m.role === 'user').length;
        const { modelId } = modelRouter.route(input, turnCount);
        modelOverride = createLanguageModel({ providerType, baseURL, apiKey, modelId });
        effectiveModelId = modelId;
      }

      const caps = resolveCapabilities(
        providerType as CatalogProviderKind,
        effectiveModelId,
      );

      await send(coreMessages, mcpTools, {
        onPersist: (text) => updateMessageContent(db, assistantMsgId, text),
        supportsTools: caps.tools,
        ...(modelOverride !== undefined ? { modelOverride } : {}),
      });
    },
    [conversationId, messages, status, send, addMessage, mcpTools, activeRole, projectContextRef, modelRouter, providerType, baseURL, apiKey, agentRegistry, projectDir, resolvedModel, roomRun, agentRun]
  );

  const handleFork = useCallback((messageIndex?: number) => {
    if (status === 'streaming') return;

    const target = messageIndex != null
      ? messages[messageIndex - 1]
      : messages[messages.length - 1];

    if (target === undefined) {
      setFeedbackMsg(messageIndex != null
        ? `No message at index ${messageIndex}. Conversation has ${messages.length} message(s).`
        : 'Nothing to fork');
      setTimeout(() => setFeedbackMsg(null), 3000);
      return;
    }

    try {
      const forked = forkConversation(db, conversationId, target.id);
      setFeedbackMsg(`Forked → ${forked.title}`);
      setTimeout(() => setFeedbackMsg(null), 3000);
      setForkCursorIdx(null);
      onForkedTo?.(forked.id);
    } catch (err) {
      const uplnkErr = toUplnkError(err);
      setFeedbackMsg(`Fork failed: ${uplnkErr.message}`);
      setTimeout(() => setFeedbackMsg(null), 4000);
      // Do NOT clear cursor — let user retry with a different selection.
    }
  }, [conversationId, messages, status, onForkedTo]);

  const handleCompact = useCallback(async () => {
    if (isCompacting || status === 'streaming') return;
    if (messages.length < COMPACT_MIN_MESSAGES) {
      setFeedbackMsg('Nothing to compact yet.');
      setTimeout(() => setFeedbackMsg(null), 3000);
      return;
    }
    const { toSummarise } = splitForCompaction(messages);
    if (toSummarise.length === 0) return;

    setIsCompacting(true);
    try {
      const summary = await summariseMessages(activeModel, toSummarise);
      const idsToRemove = toSummarise.map((m) => m.id);
      replaceWithSummary(idsToRemove, formatSummaryContent(summary));
      setFeedbackMsg(`✓ Compacted ${idsToRemove.length} messages. Context freed.`);
      setTimeout(() => setFeedbackMsg(null), 4000);
    } catch (err) {
      setFeedbackMsg(`Compact failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, status, messages, activeModel, replaceWithSummary]);

  const handleCommand = useCallback((command: string) => {
    if (command === 'help') { setShowHelp((prev) => !prev); return; }
    if (command === 'settings') { onCommand?.('settings'); return; }
    if (command === 'provider-selector' || command === 'provider') { onCommand?.('provider-selector'); return; }
    if (command === 'model-selector' || command === 'model') { onCommand?.('model-selector'); return; }
    if (command === 'fork' || command.startsWith('fork:')) {
      if (command.startsWith('fork:')) {
        const rawIdx = command.slice('fork:'.length);
        const idx = parseInt(rawIdx, 10);
        if (isNaN(idx) || idx < 1 || idx > messages.length) {
          setFeedbackMsg(`Usage: /fork [1–${messages.length}]`);
          setTimeout(() => setFeedbackMsg(null), 3000);
          return;
        }
        handleFork(idx);
      } else {
        handleFork();
      }
      return;
    }
    if (command === 'compact') { void handleCompact(); return; }
    if (command.startsWith('export:') || command === 'export') {
      const format = command === 'export:json' ? 'json' : 'markdown';
      try {
        const result = exportConversation(messages, { format });
        setFeedbackMsg(`Exported → ${result.path}`);
        setTimeout(() => setFeedbackMsg(null), 4000);
      } catch (err) {
        setFeedbackMsg(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (command.startsWith('role:')) {
      const roleId = command.slice('role:'.length).trim();
      if (roleId === 'clear') { setActiveRole(null); return; }
      const role = getRole(roleId);
      if (role) { setActiveRole(role.id); setFeedbackMsg(`Role: ${role.name}`); }
      setTimeout(() => setFeedbackMsg(null), 2000);
      return;
    }
    onCommand?.(command);
  }, [messages, onCommand, handleFork, handleCompact]);

  useInput((input, key) => {
    // Ctrl+C: abort streaming / agent run / quit.
    // Without Kitty protocol: key.ctrl=true, input='c'.
    // With Kitty protocol: \x1b[99;5u — Ink strips leading ESC → input='[99;5u',
    // key.ctrl=false. Also handle the ETX-codepoint variant '[3;5u'.
    if ((key.ctrl && input === 'c') || input === '[99;5u' || input === '[3;5u') {
      if (agentRun.status === 'running') agentRun.abort();
      else if (status === 'streaming') abort();
      else exit();
    }
    // Ctrl+K: toggle help panel.
    // Without Kitty: key.ctrl=true, input='k'.
    // With Kitty: \x1b[107;5u → Ink strips ESC → input='[107;5u'.
    if ((key.ctrl && input === 'k') || input === '[107;5u') { setShowHelp((prev) => !prev); return; }

    // Ctrl+F — enter/exit fork cursor mode
    if ((key.ctrl && input === 'f') || input === '[102;5u') {
      if (status === 'streaming') return;
      if (inForkCursor) {
        setForkCursorIdx(null);
      } else {
        setForkCursorIdx(messages.length > 0 ? messages.length - 1 : null);
      }
      return;
    }

    // Arrow keys / Enter / Esc in fork cursor mode
    if (inForkCursor) {
      if (key.upArrow) {
        setForkCursorIdx((i) => Math.max(0, (i ?? 0) - 1));
        return;
      }
      if (key.downArrow) {
        setForkCursorIdx((i) => Math.min(messages.length - 1, (i ?? 0) + 1));
        return;
      }
      if (key.return) {
        handleFork((forkCursorIdx ?? 0) + 1);
        return;
      }
      if (key.escape) {
        setForkCursorIdx(null);
        return;
      }
    }

    if (key.pageUp) { scrollUpOneMessage(); return; }
    if (key.pageDown) { scrollDownOneMessage(); return; }
    if (showHelp && key.escape && !inScrollback && activeArtifact === null) { setShowHelp(false); return; }
    if (inScrollback && key.escape && activeArtifact === null) { setScrollTopLine(0); return; }
    if (activeArtifact !== null) {
      if (key.escape) { handleDismissArtifact(); return; }
      if (input === '\t') { setFocusedPanel((p) => (p === 'chat' ? 'artifact' : 'chat')); return; }
      if (input === '[') { shrinkArtifact(); return; }
      if (input === ']') { growArtifact(); return; }
    }
  });

  const displayModelName = routerActive ? `${resolvedModel} (router)` : resolvedModel;
  const headerProps = {
    modelName: displayModelName,
    conversationTitle,
    currentDirectory,
    version: VERSION,
    connectionLabel: connectionDisplay.label,
    connectionDetail: connectionDisplay.detail,
    connectionColor: connectionDisplay.color,
    messageCount: messages.length,
    status,
    sessionTokens,
    columns: termCols,
    ...(isCompacting ? { statusOverride: 'Compacting…' } : {}),
  };

  if (pendingApproval !== null) {
    return (
      <Box flexDirection="column" height={termRows - 1}>
        <Header {...headerProps} />
        <Box flexGrow={1} />
        <ApprovalDialog
          request={pendingApproval}
          onApprove={(id) => resolveApproval(id, true)}
          onDeny={(id) => resolveApproval(id, false)}
        />
      </Box>
    );
  }

  const scrollIndicator = inScrollback ? (
    <Box paddingX={1} borderStyle="single" borderColor="#FBBF24">
      <Text color="#FBBF24">
        ── SCROLLBACK  msg {Math.min(scrollStartIdx + 1, messages.length)}–
        {Math.min(scrollEndIdx, messages.length)}/{messages.length}  ·  Esc return ──
      </Text>
    </Box>
  ) : null;

  const forkCursorBar = inForkCursor ? (
    <Box paddingX={1} borderStyle="single" borderColor="#A78BFA">
      <Text color="#A78BFA">
        ── FORK CURSOR  msg {(forkCursorIdx ?? 0) + 1}/{messages.length}
        {'  ·  '}↑↓ navigate{'  ·  '}Enter confirm{'  ·  '}Esc cancel ──
      </Text>
    </Box>
  ) : null;

  const chatContent = (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {/* Fixed scroll indicator at top of message area */}
      {scrollIndicator}
      {forkCursorBar}

      {/* Scrollable Message List with flex-end alignment to the bottom */}
      <Box
        flexDirection="column"
        flexGrow={1}
        overflow="hidden"
        justifyContent={totalContentLines > viewportLines ? 'flex-end' : 'flex-start'}
      >
        <Box flexDirection="column" flexShrink={0}>
          <MessageList
            messages={messages}
            startIdx={scrollStartIdx}
            endIdx={scrollEndIdx}
            onPromote={promoteArtifact}
            {...(forkCursorIdx !== null ? { cursorIndex: forkCursorIdx } : {})}
            {...(config.displayName !== undefined ? { displayName: config.displayName } : {})}
          />
          {(agentRun.status === 'running' || agentRun.events.length > 0) && (
            <AgentEventView
              rootInvocationId={agentRun.rootInvocationId}
              events={agentRun.events}
              registry={agentRegistry}
            />
          )}
          {(roomRun.status === 'running' || roomRun.events.length > 0) && (
            <AgentEventView
              rootInvocationId={roomRun.currentTurnRoot}
              events={roomRun.events}
              registry={roomRegistry}
            />
          )}
          {/* StreamingTextOverlay subscribes to token updates internally.
              Only the overlay re-renders per 33ms flush — ChatScreen stays stable. */}
          <StreamingTextOverlay
            textRef={streamedTextRef}
            subscribe={subscribeToStreamText}
            isStreaming={status === 'streaming'}
          />
        </Box>
      </Box>

      {/* Fixed Footer Area */}
      <Box flexDirection="column" flexShrink={0}>
        {showHelp && (
          <Box flexDirection="column" borderStyle="round" borderColor="#7B6FFF" paddingX={1} marginX={1}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text bold color="#7B6FFF">Commands</Text>
              <Text bold color="#7B6FFF">Keys</Text>
            </Box>
            <Box flexDirection="row" justifyContent="space-between">
              <Text>
                <Text color="#60A5FA">/model</Text>
                <Text dimColor>  switch model  </Text>
                <Text color="#60A5FA">/provider</Text>
                <Text dimColor>  switch provider</Text>
              </Text>
              <Text>
                <Text color="#60A5FA">/settings</Text>
                <Text dimColor>  app configuration</Text>
              </Text>
            </Box>
            <Box flexDirection="row" justifyContent="space-between">
              <Text>
                <Text color="#60A5FA">/role</Text>
                <Text dimColor>  [id|clear]  set or clear role</Text>
              </Text>
              <Text>
                <Text color="#60A5FA">Shift+Enter</Text>
                <Text dimColor>  new line</Text>
              </Text>
            </Box>
            <Box flexDirection="row" justifyContent="space-between">
              <Text>
                <Text color="#60A5FA">/fork [n]</Text>
                <Text dimColor>  branch at msg n (Ctrl+F for cursor)  </Text>
                <Text color="#60A5FA">/compact</Text>
                <Text dimColor>  summarise context</Text>
              </Text>
              <Text>
                <Text color="#60A5FA">↑↓</Text>
                <Text dimColor>  browse history  </Text>
                <Text color="#60A5FA">PgUp/Dn</Text>
                <Text dimColor>  scroll</Text>
              </Text>
            </Box>
            <Box flexDirection="row" justifyContent="space-between">
              <Text>
                <Text color="#60A5FA">/export</Text>
                <Text dimColor>  [json|md]  </Text>
                <Text color="#60A5FA">/conversations</Text>
                <Text dimColor>  history</Text>
              </Text>
              <Text>
                <Text color="#60A5FA">Ctrl+V</Text>
                <Text dimColor>  paste image or text</Text>
              </Text>
            </Box>
            <Box flexDirection="row" justifyContent="space-between">
              <Text>
                <Text color="#60A5FA">/relay</Text>
                <Text dimColor>  relay picker  </Text>
                <Text color="#60A5FA">/scan</Text>
                <Text dimColor>  network scan</Text>
              </Text>
              <Text>
                <Text color="#60A5FA">Ctrl+C</Text>
                <Text dimColor>  abort stream / quit</Text>
              </Text>
            </Box>
            <Box flexDirection="row" justifyContent="space-between">
              <Text>
                <Text color="#60A5FA">@agent</Text>
                <Text dimColor>  mention agent  </Text>
                <Text color="#60A5FA">@file</Text>
                <Text dimColor>  attach file  </Text>
                <Text color="#60A5FA">@folder/</Text>
                <Text dimColor>  attach folder</Text>
              </Text>
              <Text>
                <Text color="#60A5FA">Esc</Text>
                <Text dimColor>  close this panel</Text>
              </Text>
            </Box>
          </Box>
        )}
        {feedbackMsg !== null && (
          <Box paddingX={1}>
            <Text color="#4ADE80">{feedbackMsg}</Text>
          </Box>
        )}
        {activeRole !== null && (
          <Box paddingX={1}>
            <Text color="#475569">Role: {getRole(activeRole)?.name ?? activeRole}</Text>
          </Box>
        )}
        <ChatInput
          onSubmit={handleSubmit}
          onCommand={handleCommand}
          disabled={status === 'streaming' || agentRun.status === 'running' || roomRun.status === 'running' || focusedPanel === 'artifact' || isCompacting}
          projectDir={currentDirectory}
        />
      </Box>
    </Box>
  );

  return (
    <Box flexDirection="column" height={termRows - 1} overflow="hidden">
      {/* Fixed Header */}
      <Box flexShrink={0} height={HEADER_HEIGHT}>
        <Header {...headerProps} />
      </Box>

      {/* Main Content Area */}
      <Box flexDirection="row" flexGrow={1} overflow="hidden">
        <Box flexDirection="column" flexGrow={1} overflow="hidden" width={activeArtifact ? `${chatWidthPct}%` : '100%'}>
          {chatContent}
        </Box>
        {activeArtifact && (
          <ArtifactPanel
            artifact={activeArtifact}
            onClose={handleDismissArtifact}
            onApply={(finalCode) => updateArtifact(activeArtifact.id, { code: finalCode })}
            onSave={handleSaveArtifact}
            onCopy={handleCopyArtifact}
            focused={focusedPanel === 'artifact'}
            widthPct={artifactWidthPct}
          />
        )}
      </Box>
    </Box>
  );
}
