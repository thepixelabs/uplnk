import { useState, useCallback } from 'react';
import { Box, useInput } from 'ink';
import { ChatScreen } from './screens/ChatScreen.js';
import { ModelSelectorScreen } from './screens/ModelSelectorScreen.js';
import { ConversationListScreen } from './screens/ConversationListScreen.js';
import { ProviderSelectorScreen } from './screens/ProviderSelectorScreen.js';
import { AddProviderScreen } from './screens/AddProviderScreen.js';
import type { AuthMode, ProviderKind } from 'uplnk-providers';
import { CommandPalette } from './components/layout/CommandPalette.js';
import type { PaletteCommand } from './components/layout/CommandPalette.js';
import { ErrorBanner } from './components/layout/ErrorBanner.js';
import type { PylonError } from 'uplnk-shared';
import type { Config } from './lib/config.js';

export type Screen = 'chat' | 'model-selector' | 'conversations' | 'provider-selector' | 'add-provider' | 'edit-provider';

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

export function App({ initialModel = 'qwen2.5:7b', resumeConversationId, projectDir, config }: AppProps) {
  const [currentScreen, setCurrentScreen] = useState<Screen>('chat');
  const [activeModel, setActiveModel] = useState(initialModel);
  const [activeProvider, setActiveProvider] = useState<{
    baseUrl: string;
    apiKey: string;
  } | null>(null);
  const [globalError, setGlobalError] = useState<PylonError | null>(null);
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

  useInput((input, key) => {
    // Ctrl+K opens/closes command palette
    if (key.ctrl && input === 'k') { setPaletteOpen((o) => !o); return; }
    // Ctrl+C is handled by exitOnCtrlC in render() — no manual exit() needed
    if (key.ctrl && input === 'l') { setCurrentScreen('conversations'); return; }
    if (key.escape && paletteOpen) { setPaletteOpen(false); return; }
    if (key.escape && currentScreen !== 'chat') { setCurrentScreen('chat'); return; }
  });

  const handleNavigate = useCallback((screen: string) => {
    setCurrentScreen(screen as Screen);
  }, []);

  const handleError = useCallback((error: PylonError) => {
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
      id: 'fork', name: 'Fork current conversation', shortcut: '/fork',
      description: 'Branch a new conversation from the latest message', group: 'chat',
      execute: () => handleNavigate('fork'),
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
          // history ref.
          key={activeConversationId ?? 'new'}
          initialModel={activeModel}
          {...(activeConversationId !== undefined ? { resumeConversationId: activeConversationId } : {})}
          {...(projectDir !== undefined ? { projectDir } : {})}
          {...(config !== undefined ? { config } : {})}
          {...(activeProvider !== null ? {
            overrideBaseUrl: activeProvider.baseUrl,
            overrideApiKey: activeProvider.apiKey,
          } : {})}
          onNavigate={handleNavigate}
          onError={handleError}
          onCommand={handleNavigate}
          onForkedTo={handleForkedTo}
        />
      )}

      {!paletteOpen && currentScreen === 'model-selector' && (
        <ModelSelectorScreen
          onSelect={(model) => { setActiveModel(model); setCurrentScreen('chat'); }}
          onBack={() => setCurrentScreen('chat')}
          {...(config?.modelRouter?.enabled === true ? { routerEnabled: true } : {})}
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
          onSelect={(_, model, baseUrl, apiKey) => {
            setActiveModel(model);
            setActiveProvider({ baseUrl, apiKey });
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
    </Box>
  );
}
