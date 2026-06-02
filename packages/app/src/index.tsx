import { useState, useCallback, useRef } from 'react';
import { Box, useApp, useInput } from 'ink';
import { ChatScreen } from './screens/ChatScreen.js';
import { ModelSelectorScreen } from './screens/ModelSelectorScreen.js';
import { ConversationListScreen } from './screens/ConversationListScreen.js';
import { ProviderSelectorScreen } from './screens/ProviderSelectorScreen.js';
import { SettingsScreen } from './screens/SettingsScreen.js';
import { AddProviderScreen } from './screens/AddProviderScreen.js';
import { RelayPickerScreen } from './screens/RelayPickerScreen.js';
import { RelayRunScreen } from './screens/RelayRunScreen.js';
import { RelayEditorScreen } from './screens/RelayEditorScreen.js';
import { NetworkScanScreen } from './screens/NetworkScanScreen.js';
import { RoboticScreen } from './screens/RoboticScreen.js';
import { AltergoScreen } from './screens/AltergoScreen.js';
import { FlowListScreen } from './screens/FlowListScreen.js';
import { FlowRunnerScreen } from './screens/FlowRunnerScreen.js';
import type { LoadedFlow } from './flow/loader.js';
import type { FlowDef } from './flow/schema.js';
import type { RelayPlan } from './lib/workflows/planSchema.js';
import type { AuthMode, ProviderKind } from '@uplnk/providers';
import { CommandPalette } from './components/layout/CommandPalette.js';
import type { PaletteCommand } from './components/layout/CommandPalette.js';
import { ErrorBanner } from './components/layout/ErrorBanner.js';
import type { UplnkError } from '@uplnk/shared';
import type { Config } from './lib/config.js';

import { VoiceAssistantProvider, VoiceCommand } from './components/voice/VoiceAssistantProvider.js';
import { db, listProviders, getDefaultProvider, setProviderDefaultModel } from '@uplnk/db';
import { resolveSecret } from './lib/secrets.js';

export type { Screen } from './lib/navigation.js';
import type { Screen } from './lib/navigation.js';
import { isScreenTarget } from './lib/navigation.js';

interface EditingProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  authMode: AuthMode;
  apiKey: string;
  /**
   * Un-resolved api_key column value. Optional so callers that don't have
   * it (or pass undefined) still satisfy the type — the save path falls
   * back to migratePlaintext when it's not provided.
   */
  rawApiKey?: string | null;
  isDefault: boolean;
  defaultModel: string | null;
}

/**
 * Persist the user's model pick to the default provider's row so the
 * choice survives restart. Without this, /model only updates React state
 * and the next ChatScreen mount falls back to the seeded defaultModel.
 */
function persistModelForDefaultProvider(model: string): void {
  const row = getDefaultProvider(db);
  if (row === undefined) return;
  setProviderDefaultModel(db, row.id, model);
}

export interface AppProps {
  initialModel?: string;
  initialProvider?: string;
  resumeConversationId?: string;
  subcommand: string;
  theme?: 'dark' | 'light';
  projectDir?: string;
  /** Pre-loaded config from main(). If omitted, App falls back to getOrCreateConfig(). */
  config?: Config;
}

export function App({ initialModel, resumeConversationId, projectDir, config }: AppProps) {
  const [currentScreen, setCurrentScreen] = useState<Screen>('chat');
  const [activeConfig, setActiveConfig] = useState<Config>(() => config!);
  // Undefined means "let ChatScreen fall back to the provider's defaultModel
  // from the DB". Hardcoding a default here masks the user's configured model
  // and forces them to run /model on every startup just to make the chat work.
  const [activeModel, setActiveModel] = useState<string | undefined>(initialModel);
  const [activeProvider, setActiveProvider] = useState<{
    baseUrl: string;
    apiKey: string;
    providerType: ProviderKind;
    authMode: AuthMode;
  } | null>(null);
  // Incremented on every provider switch so ChatScreen remounts and re-reads
  // the new provider credentials from its props rather than using its cached
  // providerRef value from a previous mount.
  const [providerKey, setProviderKey] = useState(0);
  const [globalError, setGlobalError] = useState<UplnkError | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // The active conversation id is lifted to App so we can remount ChatScreen
  // via `key` whenever the user picks a different conversation (resume) or
  // forks the current one. This avoids having ChatScreen manage two lifetimes.
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>(
    resumeConversationId,
  );

  // Provider currently being edited via the AddProviderScreen-in-edit-mode
  // path. Cleared on save/cancel.
  const [editingProvider, setEditingProvider] = useState<EditingProvider | null>(null);

  // Relay run state — the picker hands a (plan, userInput) pair to the run
  // screen via App so we can route back to the picker on Esc/done.
  const [activeRelayRun, setActiveRelayRun] = useState<{ plan: RelayPlan; userInput: string } | null>(null);
  // planId being edited in RelayEditorScreen (undefined = new plan).
  const [editingRelayId, setEditingRelayId] = useState<string | undefined>(undefined);

  // Flow engine — the list screen hands us a LoadedFlow+FlowDef pair to run.
  const [activeFlow, setActiveFlow] = useState<{ def: FlowDef; loaded: LoadedFlow } | null>(null);

  const { exit } = useApp();

  const handleVoiceCommand = useCallback((cmd: VoiceCommand) => {
    if (cmd.type === 'CHANGE_PROVIDER') {
      const allProviders = listProviders(db);
      const match = allProviders.find(p => 
        p.name.toLowerCase().includes(cmd.providerName.toLowerCase()) ||
        cmd.providerName.toLowerCase().includes(p.name.toLowerCase())
      );
      if (match) {
        const resolved = resolveSecret(match.apiKey);
        setActiveProvider({
          baseUrl: match.baseUrl,
          apiKey: resolved || '',
          providerType: match.providerType as ProviderKind,
          authMode: (match.authMode || 'none') as AuthMode,
        });
        if (match.defaultModel) setActiveModel(match.defaultModel);
        setProviderKey(k => k + 1);
        setCurrentScreen('chat');
      }
    } else if (cmd.type === 'SWITCH_MODEL') {
      persistModelForDefaultProvider(cmd.modelName);
      setActiveModel(cmd.modelName);
      setCurrentScreen('chat');
    } else if (cmd.type === 'CLEAR_CHAT') {
      setActiveConversationId(undefined);
      setCurrentScreen('chat');
    }
  }, []);

  useInput((input, key) => {
    // Ctrl+K opens/closes command palette
    if (key.ctrl && input === 'k') { setPaletteOpen((o) => !o); return; }
    // Ctrl+C exits the app. On the chat screen, ChatScreen owns this key so it
    // can abort a stream first (abort on first press, exit on second). On every
    // other screen there is no stream to abort, so we exit directly here.
    if ((key.ctrl && input === 'c') || input === '[99;5u' || input === '[3;5u') {
      if (currentScreen !== 'chat') { exit(); return; }
    }
    if (key.ctrl && input === 'l') { setCurrentScreen('conversations'); return; }
    // Ctrl+, opens Settings. Two forms: plain (key.ctrl + ',') and kitty
    // keyboard protocol ('[44;5u' — Ink strips the leading ESC). Matching both
    // means it works in iTerm2/kitty with the protocol on and in basic terminals.
    if ((key.ctrl && input === ',') || input === '[44;5u') { setCurrentScreen('settings'); return; }
    // Kitty keyboard protocol sends plain ESC as the sequence \x1b[27u.
    // Ink strips the leading \x1b, so it arrives as input === '[27u' with
    // key.escape === false. Accept either form for both palette and screen Esc.
    const escPressed = key.escape || input === '[27u';
    if (escPressed && paletteOpen) { setPaletteOpen(false); return; }
    // Screens with multi-step internal Esc handling own their own back nav.
    // The global "Esc → chat" shortcut would otherwise stomp on their state
    // (e.g. RelayEditorScreen's wizard step-back, RelayRunScreen's abort+
    // return-to-picker, NetworkScanScreen's cancelScan).
    const ownsEsc =
      currentScreen === 'relay-editor' ||
      currentScreen === 'relay-run' ||
      currentScreen === 'relay-picker' ||
      currentScreen === 'network-scan' ||
      currentScreen === 'flow-list' ||
      currentScreen === 'flow-run' ||
      // Add/edit-provider is a multi-step wizard; step-back Esc is handled
      // internally. The global handler would stomp on it and navigate away
      // before the wizard's own handler runs, leaving the user stuck.
      currentScreen === 'add-provider' ||
      currentScreen === 'edit-provider';
    if (escPressed && currentScreen !== 'chat' && !ownsEsc) { setCurrentScreen('chat'); return; }
  });

  // Queue of chat-level commands dispatched from outside ChatScreen (the
  // Ctrl+K command palette is the only such caller today). Each enqueue
  // creates a new object so React's identity check re-fires ChatScreen's
  // consumer effect even when the same command is dispatched twice — the
  // counter is not strictly needed for that, but it makes the queue
  // trivially debuggable in DevTools.
  const [pendingChatCommand, setPendingChatCommand] = useState<{ command: string; nonce: number } | null>(null);
  const chatCommandNonceRef = useRef(0);

  const handleConsumedChatCommand = useCallback(() => {
    setPendingChatCommand(null);
  }, []);

  const handleNavigate = useCallback((target: string) => {
    if (isScreenTarget(target)) {
      setCurrentScreen(target);
      return;
    }
    // Anything that isn't a screen name is a chat-level command. Make sure
    // chat is the visible screen (so the command's side-effects are seen
    // immediately) and queue the command for ChatScreen's effect to run.
    chatCommandNonceRef.current += 1;
    setPendingChatCommand({ command: target, nonce: chatCommandNonceRef.current });
    setCurrentScreen('chat');
  }, []);

  const handleError = useCallback((error: UplnkError) => {
    setGlobalError(error);
  }, []);

  /**
   * Resume a specific conversation by id. Sets the active id and returns to
   * the chat screen — ChatScreen's `key` is the id so React unmounts the old
   * instance and remounts a fresh one that re-reads the new conversation
   * from SQLite via `useConversation(resumeId)`.
   */
  const handleResumeConversation = useCallback((conversationId: string) => {
    setActiveConversationId(conversationId);
    setCurrentScreen('chat');
  }, []);

  /**
   * Called by ChatScreen when the user runs /fork. The new conversation id
   * is already written to SQLite (in ChatScreen's handler); all we do here is
   * remount ChatScreen on the new id.
   */
  const handleForkedTo = useCallback((newConversationId: string) => {
    setActiveConversationId(newConversationId);
  }, []);

  // Palette commands — registered here at App level so they have access to navigation state
  const paletteCommands: PaletteCommand[] = [
    {
      id: 'model-selector', name: 'Switch model', shortcut: '/model',
      description: 'Choose a different model', group: 'chat',
      execute: () => setCurrentScreen('model-selector'),
    },
    {
      id: 'provider-selector', name: 'Switch provider', shortcut: '/provider',
      description: 'Choose a different provider profile', group: 'chat',
      execute: () => setCurrentScreen('provider-selector'),
    },
    {
      id: 'settings', name: 'Settings', shortcut: '/settings',
      description: 'Manage app configuration', group: 'chat',
      execute: () => setCurrentScreen('settings'),
    },
    {
      id: 'add-provider', name: 'Add provider', shortcut: '/add-provider',
      description: 'Connect to a remote model server', group: 'chat',
      execute: () => setCurrentScreen('add-provider'),
    },
    {
      id: 'conversations', name: 'Conversation history', shortcut: 'Ctrl+L',
      description: 'Browse and resume past conversations', group: 'chat',
      execute: () => setCurrentScreen('conversations'),
    },
    {
      id: 'relay', name: 'Relays', shortcut: '/relay',
      description: 'Browse and run two-phase scout/anchor relays', group: 'chat',
      execute: () => setCurrentScreen('relay-picker'),
    },
    {
      id: 'scan', name: 'Network scan', shortcut: '/scan',
      description: 'Discover local AI servers on this machine or subnet', group: 'chat',
      execute: () => setCurrentScreen('network-scan'),
    },
    {
      id: 'flows', name: 'Flows', shortcut: '/flows',
      description: 'Browse and run autonomous flows', group: 'chat',
      execute: () => setCurrentScreen('flow-list'),
    },
    {
      id: 'altergo', name: 'Altergo accounts', shortcut: '/altergo',
      description: 'Manage AI coding assistant accounts', group: 'chat',
      execute: () => setCurrentScreen('altergo'),
    },
    {
      id: 'robotic', name: 'Robotic mode', shortcut: '/robotic',
      description: 'Autonomous AI-to-AI orchestration', group: 'chat',
      execute: () => setCurrentScreen('robotic'),
    },
    {
      id: 'fork', name: 'Fork current conversation', shortcut: '/fork',
      description: 'Branch a new conversation from the latest message', group: 'chat',
      execute: () => handleNavigate('fork'),
    },
    {
      id: 'mcp-status', name: 'MCP server status', shortcut: '/mcp',
      description: 'View MCP server connections and retry failures', group: 'chat',
      execute: () => handleNavigate('mcp'),
    },
    {
      id: 'export-md', name: 'Export as Markdown', shortcut: '/export',
      description: 'Save conversation to .md file', group: 'export',
      execute: () => handleNavigate('export:markdown'),
    },
    {
      id: 'export-json', name: 'Export as JSON', shortcut: '/export json',
      description: 'Save conversation to .json file', group: 'export',
      execute: () => handleNavigate('export:json'),
    },
    {
      id: 'tpl-code-review', name: 'Role: Code Reviewer',
      description: 'Switch to code review persona', group: 'roles',
      execute: () => handleNavigate('role:code-reviewer'),
    },
    {
      id: 'tpl-refactor', name: 'Role: Refactoring Partner',
      description: 'Switch to refactoring persona', group: 'roles',
      execute: () => handleNavigate('role:refactoring-partner'),
    },
    {
      id: 'tpl-debug', name: 'Role: Debug Assistant',
      description: 'Switch to debug persona', group: 'roles',
      execute: () => handleNavigate('role:debug-assistant'),
    },
    {
      id: 'tpl-clear', name: 'Clear role',
      description: 'Remove active role', group: 'roles',
      execute: () => handleNavigate('role:clear'),
    },
  ];

  return (
    <VoiceAssistantProvider onCommand={handleVoiceCommand}>
      <Box flexDirection="column">
        {globalError && (
          <ErrorBanner error={globalError} onDismiss={() => setGlobalError(null)} />
        )}

        {paletteOpen && (
          <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
        )}

        {!paletteOpen && currentScreen === 'chat' && (
        <ChatScreen
          // `key` on the conversation id forces a clean remount on resume /
          // fork — clears streaming state, tool-call counter, artifact panel,
          // history ref. providerKey is appended so a provider switch also
          // remounts ChatScreen, forcing it to re-read the new credentials
          // from props instead of its cached providerRef. activeConfig.displayName
          // is included so changing the profile also remounts the chat.
          key={`${activeConversationId ?? 'new'}-${providerKey}-${activeConfig.displayName ?? 'default'}`}
          {...(activeModel !== undefined ? { initialModel: activeModel } : {})}
          {...(activeConversationId !== undefined ? { resumeConversationId: activeConversationId } : {})}
          {...(projectDir !== undefined ? { projectDir } : {})}
          config={activeConfig}
          {...(activeProvider !== null ? {
            overrideBaseUrl: activeProvider.baseUrl,
            overrideApiKey: activeProvider.apiKey,
            overrideProviderType: activeProvider.providerType,
            overrideAuthMode: activeProvider.authMode,
          } : {})}
          onNavigate={handleNavigate}
          onError={handleError}
          onCommand={handleNavigate}
          onForkedTo={handleForkedTo}
          {...(pendingChatCommand !== null ? { pendingCommand: pendingChatCommand } : {})}
          onCommandConsumed={handleConsumedChatCommand}
        />
      )}

      {!paletteOpen && currentScreen === 'model-selector' && (
        <ModelSelectorScreen
          onSelect={(model) => {
            persistModelForDefaultProvider(model);
            setActiveModel(model);
            setCurrentScreen('chat');
          }}
          onBack={() => setCurrentScreen('chat')}
          {...(activeConfig.modelRouter?.enabled === true ? { routerEnabled: true } : {})}
        />
      )}

      {!paletteOpen && currentScreen === 'conversations' && (
        <ConversationListScreen
          onSelect={handleResumeConversation}
          onBack={() => setCurrentScreen('chat')}
        />
      )}

      {!paletteOpen && currentScreen === 'provider-selector' && (
        <ProviderSelectorScreen
          onSelect={(_, model, baseUrl, apiKey, providerType, authMode) => {
            setActiveModel(model);
            setActiveProvider({ baseUrl, apiKey, providerType, authMode });
            setProviderKey(k => k + 1);
            setCurrentScreen('chat');
          }}
          onBack={() => setCurrentScreen('chat')}
          onAdd={() => setCurrentScreen('add-provider')}
          onEdit={(p) => {
            setEditingProvider(p);
            setCurrentScreen('edit-provider');
          }}
        />
      )}

      {!paletteOpen && currentScreen === 'settings' && (
        <SettingsScreen
          onBack={() => setCurrentScreen('chat')}
          config={activeConfig}
          onDone={(newConfig) => { setActiveConfig(newConfig); setCurrentScreen('chat'); }}
        />
      )}

      {!paletteOpen && currentScreen === 'add-provider' && (
        <AddProviderScreen
          onDone={() => setCurrentScreen('provider-selector')}
          onCancel={() => setCurrentScreen('provider-selector')}
        />
      )}

      {!paletteOpen && currentScreen === 'edit-provider' && editingProvider !== null && (
        <AddProviderScreen
          editing={editingProvider}
          onDone={() => {
            setEditingProvider(null);
            setCurrentScreen('provider-selector');
          }}
          onCancel={() => {
            setEditingProvider(null);
            setCurrentScreen('provider-selector');
          }}
        />
      )}

      {!paletteOpen && currentScreen === 'relay-picker' && (
        <RelayPickerScreen
          onRunRelay={(plan, input) => {
            setActiveRelayRun({ plan, userInput: input });
            setCurrentScreen('relay-run');
          }}
          onEdit={(planId) => {
            setEditingRelayId(planId);
            setCurrentScreen('relay-editor');
          }}
          onNew={() => {
            setEditingRelayId(undefined);
            setCurrentScreen('relay-editor');
          }}
          onBack={() => setCurrentScreen('chat')}
        />
      )}

      {!paletteOpen && currentScreen === 'relay-run' && activeRelayRun !== null && (
        <RelayRunScreen
          plan={activeRelayRun.plan}
          userInput={activeRelayRun.userInput}
          onBack={() => {
            setActiveRelayRun(null);
            setCurrentScreen('relay-picker');
          }}
        />
      )}

      {!paletteOpen && currentScreen === 'relay-editor' && (
        <RelayEditorScreen
          {...(editingRelayId !== undefined ? { planId: editingRelayId } : {})}
          onDone={() => {
            setEditingRelayId(undefined);
            setCurrentScreen('relay-picker');
          }}
          onCancel={() => {
            setEditingRelayId(undefined);
            setCurrentScreen('relay-picker');
          }}
        />
      )}

      {!paletteOpen && currentScreen === 'network-scan' && (
        <NetworkScanScreen
          onBack={() => setCurrentScreen('chat')}
          {...(activeConfig.networkScanner?.subnetConfirmedAt !== undefined
            ? { subnetConfirmedAt: activeConfig.networkScanner.subnetConfirmedAt }
            : {})}
        />
      )}

      {!paletteOpen && currentScreen === 'flow-list' && (
        <FlowListScreen
          onBack={() => setCurrentScreen('chat')}
          onRun={(def, loaded) => {
            setActiveFlow({ def, loaded });
            setCurrentScreen('flow-run');
          }}
          config={activeConfig}
        />
      )}
      {!paletteOpen && currentScreen === 'flow-run' && activeFlow !== null && (
        <FlowRunnerScreen
          loadedFlow={activeFlow.loaded}
          onDone={() => {
            setActiveFlow(null);
            setCurrentScreen('flow-list');
          }}
          onBack={() => {
            setActiveFlow(null);
            setCurrentScreen('flow-list');
          }}
          config={activeConfig}
        />
      )}
      {!paletteOpen && currentScreen === 'altergo' && (
        <AltergoScreen
          onBack={() => setCurrentScreen('chat')}
          config={activeConfig}
        />
      )}
      {!paletteOpen && currentScreen === 'robotic' && (
        <RoboticScreen
          onBack={() => setCurrentScreen('chat')}
          config={activeConfig}
        />
      )}
    </Box>
    </VoiceAssistantProvider>
  );
}
