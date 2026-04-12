import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { CoreMessage, LanguageModel } from 'ai';
import { createLanguageModel } from '../lib/languageModelFactory.js';
import { db, getDefaultProvider, insertMessage, updateMessageContent, forkConversation, updateConversationTitle } from 'uplnk-db';
import { resolveSecret } from '../lib/secrets.js';
import { useStream } from '../hooks/useStream.js';
import { useConversation } from '../hooks/useConversation.js';
import { useArtifacts } from '../hooks/useArtifacts.js';
import { useMcp } from '../hooks/useMcp.js';
import { useSplitPane } from '../hooks/useSplitPane.js';
import { getOrCreateConfig } from '../lib/config.js';
import type { Config } from '../lib/config.js';
import { ModelRouter } from '../lib/modelRouter.js';
import { buildProjectContext } from '../lib/projectContext.js';
import { exportConversation } from '../lib/exportConversation.js';
import { getRole, BUILT_IN_ROLES } from '../lib/roles.js';
import { MessageList } from '../components/chat/MessageList.js';
import { StreamingMessage } from '../components/chat/StreamingMessage.js';
import { ChatInput } from '../components/chat/ChatInput.js';
import { Header } from '../components/layout/Header.js';
import { StatusBar } from '../components/layout/StatusBar.js';
import { ArtifactPanel } from '../components/artifacts/ArtifactPanel.js';
import { ApprovalDialog } from '../components/mcp/ApprovalDialog.js';
import type { PylonError } from 'uplnk-shared';

interface Props {
  initialModel?: string;
  resumeConversationId?: string;
  projectDir?: string;
  overrideBaseUrl?: string;
  overrideApiKey?: string;
  config?: Config;
  onNavigate?: (screen: string) => void;
  onError: (error: PylonError) => void;
  onCommand?: (command: string) => void;
  /**
   * Fired after a /fork creates a new conversation. App reacts by remounting
   * ChatScreen with the forked id so streaming state and message history
   * reset cleanly.
   */
  onForkedTo?: (newConversationId: string) => void;
}

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
};

export function ChatScreen({ initialModel, resumeConversationId, projectDir, overrideBaseUrl, overrideApiKey, config: configProp, onError, onCommand, onForkedTo }: Props) {
  const { exit } = useApp();

  // Use config passed from bin/pylon.ts. Falls back to getOrCreateConfig() for
  // non-CLI entry points (tests, Storybook). In production the config is always
  // provided — bin/pylon.ts exits early if it's invalid.
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
  const providerRef = useRef<{ baseURL: string; apiKey: string; defaultModel: string; providerType: string } | null>(null);
  if (providerRef.current === null) {
    const row = getDefaultProvider(db);
    const resolvedKey = overrideApiKey ?? resolveSecret(row?.apiKey) ?? 'ollama';
    providerRef.current = {
      baseURL: overrideBaseUrl ?? row?.baseUrl ?? 'http://localhost:11434/v1',
      apiKey: resolvedKey,
      defaultModel: row?.defaultModel ?? config.defaultModel ?? 'llama3.2',
      providerType: row?.providerType ?? 'ollama',
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const { baseURL, apiKey, defaultModel, providerType } = providerRef.current!;

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
  const { conversationId, messages, addMessage } = useConversation(resumeConversationId);

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

  // Build project context once at mount — used as a system message prefix
  const projectContextRef = useRef<string | null>(null);
  if (projectContextRef.current === null && projectDir !== undefined) {
    const ctx = buildProjectContext(projectDir);
    projectContextRef.current = ctx?.systemPrompt ?? null;
  }

  const { streamedText, status, activeToolName, error, send, abort } = useStream(activeModel);
  const { activeArtifact, promoteArtifact, dismissArtifact, updateArtifact } = useArtifacts();
  const { artifactWidthPct, chatWidthPct, growArtifact, shrinkArtifact } = useSplitPane();
  const prevStatusRef = useRef(status);

  // Focus ownership: 'chat' lets ChatInput receive keys; 'artifact' forwards keys
  // to ArtifactPanel. Tab (in ChatScreen's useInput) toggles when a panel is open.
  const [focusedPanel, setFocusedPanel] = useState<'chat' | 'artifact'>('chat');

  const handleDismissArtifact = useCallback(() => {
    dismissArtifact();
    setFocusedPanel('chat');
  }, [dismissArtifact]);

  // Active role (null = no role)
  const [activeRole, setActiveRole] = useState<string | null>(null);
  // Transient feedback message (export confirmation, role applied, etc.)
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);

  // Build role system prompt — injected as system message if no existing one.
  // Declared here (above handleSubmit) so it's in scope for the useCallback dep array.
  const rolePrompt = activeRole !== null ? getRole(activeRole)?.prompt : undefined;

  // Track the id of the in-flight assistant message for incremental persistence.
  // Set before streaming starts; cleared when done.
  const assistantMessageIdRef = useRef<string | null>(null);

  // Commit the completed assistant message to React state and DB.
  // C1 note: when incremental persistence is active (assistantMessageIdRef is set),
  // the DB row was pre-inserted and updated via onPersist. addMessage here creates
  // a second row — this is a known v1.0 issue tracked as tech debt.
  // Resolution: expose appendToState() from useConversation to update state-only.
  useEffect(() => {
    if (prevStatusRef.current === 'streaming' && status === 'done' && streamedText) {
      addMessage({ role: 'assistant', content: streamedText });
      assistantMessageIdRef.current = null;
    }
    prevStatusRef.current = status;
  }, [status, streamedText, addMessage]);

  useEffect(() => {
    if (error) onError(error);
  }, [error, onError]);

  const handleSubmit = useCallback(
    async (input: string) => {
      if (!input.trim() || status === 'streaming') return;

      // Auto-derive a title on the first user message so the conversation
      // list isn't full of rows reading "New conversation". We derive from
      // the user's own words (first line, clamped to 60 chars) — no LLM
      // call required, no extra latency, works offline. Idempotent: only
      // runs when the conversation currently has no messages.
      if (messages.length === 0) {
        const firstLine = input.trim().split(/\r?\n/)[0] ?? input.trim();
        const title = firstLine.slice(0, 60).trim();
        if (title !== '') {
          try {
            updateConversationTitle(db, conversationId, title);
          } catch {
            // Non-fatal — title is cosmetic.
          }
        }
      }

      addMessage({ role: 'user', content: input });

      // Build CoreMessage history — messages state hasn't updated yet (setState is async),
      // so we append the new user message explicitly at the end.
      // System message priority: role > project context > none
      // Only inject if there isn't already a system message persisted in the conversation.
      const hasSystemMessage = messages.some((m) => m.role === 'system');
      const systemContent = !hasSystemMessage
        ? (rolePrompt ?? projectContextRef.current ?? null)
        : null;
      const projectSystemMessage: CoreMessage | null =
        systemContent !== null
          ? { role: 'system', content: systemContent }
          : null;

      const coreMessages: CoreMessage[] = [
        ...(projectSystemMessage !== null ? [projectSystemMessage] : []),
        ...messages
          .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
          .map((m): CoreMessage => {
            if (m.role === 'assistant') return { role: 'assistant', content: m.content ?? '' };
            if (m.role === 'system') return { role: 'system', content: m.content ?? '' };
            return { role: 'user', content: m.content ?? '' };
          }),
        { role: 'user', content: input },
      ];

      // C1: Insert an empty assistant row ONLY in SQLite (not React state) so partial
      // text survives a SIGKILL mid-stream. React state is updated at the end via
      // updateMessageInState (which replaces the placeholder content).
      // Not calling addMessageWithId to avoid showing an empty bubble in the UI.
      const assistantMsgId = crypto.randomUUID();
      assistantMessageIdRef.current = assistantMsgId;
      insertMessage(db, {
        id: assistantMsgId,
        conversationId,
        role: 'assistant',
        content: '',
      });

      // Model routing: when the router is active, pick the best model for this
      // message and override the hook's default model for this single request.
      let modelOverride: LanguageModel | undefined;
      if (modelRouter !== null) {
        // conversationTurnCount = user messages already in state (before this one)
        const turnCount = messages.filter((m) => m.role === 'user').length;
        const { modelId } = modelRouter.route(input, turnCount);
        modelOverride = createLanguageModel({ providerType, baseURL, apiKey, modelId });
      }

      // Pass MCP tools to the stream, plus the persistence callback
      await send(coreMessages, mcpTools, {
        onPersist: (text) => updateMessageContent(db, assistantMsgId, text),
        ...(modelOverride !== undefined ? { modelOverride } : {}),
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationId, messages, status, send, addMessage, mcpTools, rolePrompt, modelRouter, baseURL, apiKey],
  );

  const handleFork = useCallback(() => {
    if (status === 'streaming') {
      setFeedbackMsg('Cannot fork while streaming. Wait for the response to finish or Ctrl+C to abort.');
      setTimeout(() => setFeedbackMsg(null), 4000);
      return;
    }
    const lastMsg = messages[messages.length - 1];
    if (lastMsg === undefined) {
      setFeedbackMsg('Nothing to fork — send at least one message first.');
      setTimeout(() => setFeedbackMsg(null), 4000);
      return;
    }
    try {
      const forked = forkConversation(db, conversationId, lastMsg.id);
      setFeedbackMsg(`Forked → ${forked.title}`);
      setTimeout(() => setFeedbackMsg(null), 3000);
      onForkedTo?.(forked.id);
    } catch (err) {
      setFeedbackMsg(`Fork failed: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(() => setFeedbackMsg(null), 4000);
    }
  }, [conversationId, messages, status, onForkedTo]);

  // Handle commands from ChatInput (slash commands and navigation)
  const handleCommand = useCallback((command: string) => {
    if (command === 'fork') {
      handleFork();
      return;
    }
    if (command.startsWith('export:') || command === 'export') {
      const format = command === 'export:json' ? 'json' : 'markdown';
      try {
        const result = exportConversation(messages, { format });
        setFeedbackMsg(`Exported ${result.messageCount} messages → ${result.path}`);
        setTimeout(() => setFeedbackMsg(null), 4000);
      } catch (err) {
        setFeedbackMsg(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
        setTimeout(() => setFeedbackMsg(null), 4000);
      }
      return;
    }

    if (command.startsWith('role:')) {
      const roleId = command.slice('role:'.length).trim();
      if (roleId === '' || roleId === 'list') {
        // Show available roles as feedback
        const list = BUILT_IN_ROLES.map((t) => `  ${t.id} — ${t.name}`).join('\n');
        setFeedbackMsg(`Available roles:\n${list}`);
        setTimeout(() => setFeedbackMsg(null), 8000);
        return;
      }
      if (roleId === 'clear') {
        setActiveRole(null);
        setFeedbackMsg('Role cleared.');
        setTimeout(() => setFeedbackMsg(null), 2000);
        return;
      }
      const role = getRole(roleId);
      if (role !== undefined) {
        setActiveRole(role.id);
        setFeedbackMsg(`Role: ${role.name} — applied.`);
        setTimeout(() => setFeedbackMsg(null), 2000);
      } else {
        setFeedbackMsg(`Unknown role: ${roleId}. Use /role list to see options.`);
        setTimeout(() => setFeedbackMsg(null), 4000);
      }
      return;
    }

    // Navigation commands
    onCommand?.(command);
  }, [messages, onCommand, handleFork]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (status === 'streaming') {
        abort();
      } else {
        exit();
      }
    }

    if (activeArtifact !== null) {
      // Escape dismisses the artifact panel (no readline conflict)
      if (key.escape) {
        handleDismissArtifact();
        return;
      }
      // Tab toggles keyboard focus between chat and artifact panel
      if (input === '\t') {
        setFocusedPanel((p) => (p === 'chat' ? 'artifact' : 'chat'));
        return;
      }
      // [ / ] resize the artifact panel in split-pane mode
      if (input === '[') { shrinkArtifact(); return; }
      if (input === ']') { growArtifact(); return; }
    }
  });

  const hasSplitPane = activeArtifact !== null;

  // When routing is enabled, append "(router)" to the displayed model name so
  // the user knows that automatic model selection is in effect.
  const displayModelName = routerActive ? `${resolvedModel} (router)` : resolvedModel;

  // When an approval dialog is pending, render it as a blocking overlay
  if (pendingApproval !== null) {
    return (
      <Box flexDirection="column">
        <Header modelName={displayModelName} conversationTitle="New conversation" />
        <ApprovalDialog
          request={pendingApproval}
          onApprove={(id) => resolveApproval(id, true)}
          onDeny={(id) => resolveApproval(id, false)}
        />
      </Box>
    );
  }

  const chatContent = (
    <Box flexDirection="column" flexGrow={1}>
      <MessageList messages={messages} onPromote={promoteArtifact} />
      <StreamingMessage text={streamedText} status={status} />
      {feedbackMsg !== null && (
        <Box paddingX={1} marginY={1}>
          <Text color="#4ADE80">{feedbackMsg}</Text>
        </Box>
      )}
      {activeRole !== null && (
        <Box paddingX={1}>
          <Text color="#475569">Role: {getRole(activeRole)?.name ?? activeRole}  /role clear to remove</Text>
        </Box>
      )}
      <StatusBar status={status} messageCount={messages.length} activeToolName={activeToolName} />
      <ChatInput
        onSubmit={handleSubmit}
        onCommand={handleCommand}
        disabled={status === 'streaming' || focusedPanel === 'artifact'}
        {...(projectDir !== undefined ? { projectDir } : {})}
      />
    </Box>
  );

  return (
    <Box flexDirection="column">
      <Header modelName={displayModelName} conversationTitle="New conversation" />
      {hasSplitPane ? (
        <Box flexDirection="row" flexGrow={1}>
          <Box flexDirection="column" width={`${chatWidthPct}%`}>
            {chatContent}
          </Box>
          <ArtifactPanel
            artifact={activeArtifact}
            onClose={handleDismissArtifact}
            onApply={(finalCode) => {
              if (activeArtifact !== null) {
                updateArtifact(activeArtifact.id, { code: finalCode });
              }
            }}
            focused={focusedPanel === 'artifact'}
            widthPct={artifactWidthPct}
          />
        </Box>
      ) : (
        chatContent
      )}
    </Box>
  );
}
