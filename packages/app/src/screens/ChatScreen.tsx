import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { CoreMessage, LanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { db, getDefaultProvider, insertMessage, updateMessageContent } from 'pylon-db';
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
import { getTemplate, BUILT_IN_TEMPLATES } from '../lib/systemPromptTemplates.js';
import { MessageList } from '../components/chat/MessageList.js';
import { StreamingMessage } from '../components/chat/StreamingMessage.js';
import { ChatInput } from '../components/chat/ChatInput.js';
import { Header } from '../components/layout/Header.js';
import { StatusBar } from '../components/layout/StatusBar.js';
import { ArtifactPanel } from '../components/artifacts/ArtifactPanel.js';
import { ApprovalDialog } from '../components/mcp/ApprovalDialog.js';
import type { PylonError } from 'pylon-shared';

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
}

const DEFAULT_CONFIG: Config = {
  version: 1,
  theme: 'dark',
  telemetry: { enabled: false },
  mcp: { allowedPaths: [], commandExecEnabled: false, commandAllowlistAdditions: [] },
  git: { enabled: true },
  rag: { enabled: false },
  updates: { enabled: true, packageName: 'pylon-dev' },
  // modelRouter is intentionally absent — defaults to disabled
};

export function ChatScreen({ initialModel, resumeConversationId, projectDir, overrideBaseUrl, overrideApiKey, config: configProp, onError, onCommand }: Props) {
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

  // Provider settings — loaded once via ref, but overrides from props take priority
  const providerRef = useRef<{ baseURL: string; apiKey: string; defaultModel: string } | null>(null);
  if (providerRef.current === null) {
    const row = getDefaultProvider(db);
    providerRef.current = {
      baseURL: overrideBaseUrl ?? row?.baseUrl ?? 'http://localhost:11434/v1',
      apiKey: overrideApiKey ?? row?.apiKey ?? 'ollama',
      defaultModel: row?.defaultModel ?? config.defaultModel ?? 'llama3.2',
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const { baseURL, apiKey, defaultModel } = providerRef.current!;

  const resolvedModel = initialModel ?? defaultModel;

  const activeModel = useMemo(() => {
    const ollamaProvider = createOpenAICompatible({ name: 'ollama', baseURL, apiKey });
    return ollamaProvider(resolvedModel);
  }, [baseURL, apiKey, resolvedModel]);

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

  // Active system prompt template (null = no template)
  const [activeTemplate, setActiveTemplate] = useState<string | null>(null);
  // Transient feedback message (export confirmation, template applied, etc.)
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);

  // Build template system prompt — injected as system message if no existing one.
  // Declared here (above handleSubmit) so it's in scope for the useCallback dep array.
  const templatePrompt = activeTemplate !== null ? getTemplate(activeTemplate)?.prompt : undefined;

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

      addMessage({ role: 'user', content: input });

      // Build CoreMessage history — messages state hasn't updated yet (setState is async),
      // so we append the new user message explicitly at the end.
      // System message priority: template > project context > none
      // Only inject if there isn't already a system message persisted in the conversation.
      const hasSystemMessage = messages.some((m) => m.role === 'system');
      const systemContent = !hasSystemMessage
        ? (templatePrompt ?? projectContextRef.current ?? null)
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
        const ollamaProvider = createOpenAICompatible({ name: 'ollama', baseURL, apiKey });
        modelOverride = ollamaProvider(modelId);
      }

      // Pass MCP tools to the stream, plus the persistence callback
      await send(coreMessages, mcpTools, {
        onPersist: (text) => updateMessageContent(db, assistantMsgId, text),
        ...(modelOverride !== undefined ? { modelOverride } : {}),
      });
    },
    [conversationId, messages, status, send, addMessage, mcpTools, templatePrompt, modelRouter, baseURL, apiKey],
  );

  // Handle commands from ChatInput (slash commands and navigation)
  const handleCommand = useCallback((command: string) => {
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

    if (command.startsWith('template:')) {
      const templateId = command.slice('template:'.length).trim();
      if (templateId === '' || templateId === 'list') {
        // Show available templates as feedback
        const list = BUILT_IN_TEMPLATES.map((t) => `  ${t.id} — ${t.name}`).join('\n');
        setFeedbackMsg(`Available templates:\n${list}`);
        setTimeout(() => setFeedbackMsg(null), 8000);
        return;
      }
      if (templateId === 'clear') {
        setActiveTemplate(null);
        setFeedbackMsg('Template cleared.');
        setTimeout(() => setFeedbackMsg(null), 2000);
        return;
      }
      const tmpl = getTemplate(templateId);
      if (tmpl !== undefined) {
        setActiveTemplate(tmpl.id);
        setFeedbackMsg(`Template: ${tmpl.name} — applied.`);
        setTimeout(() => setFeedbackMsg(null), 2000);
      } else {
        setFeedbackMsg(`Unknown template: ${templateId}. Use /template list to see options.`);
        setTimeout(() => setFeedbackMsg(null), 4000);
      }
      return;
    }

    // Navigation commands
    onCommand?.(command);
  }, [messages, onCommand]);

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
      {activeTemplate !== null && (
        <Box paddingX={1}>
          <Text color="#475569">Template: {getTemplate(activeTemplate)?.name ?? activeTemplate}  /template clear to remove</Text>
        </Box>
      )}
      <StatusBar status={status} messageCount={messages.length} activeToolName={activeToolName} />
      <ChatInput
        onSubmit={handleSubmit}
        onCommand={handleCommand}
        disabled={status === 'streaming' || focusedPanel === 'artifact'}
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
