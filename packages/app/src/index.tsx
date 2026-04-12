import { useState, useCallback } from 'react';
import { Box, useInput } from 'ink';
import { ChatScreen } from './screens/ChatScreen.js';
import { ModelSelectorScreen } from './screens/ModelSelectorScreen.js';
import { ConversationListScreen } from './screens/ConversationListScreen.js';
import { ProviderSelectorScreen } from './screens/ProviderSelectorScreen.js';
import { CommandPalette } from './components/layout/CommandPalette.js';
import type { PaletteCommand } from './components/layout/CommandPalette.js';
import { ErrorBanner } from './components/layout/ErrorBanner.js';
import type { PylonError } from 'pylon-shared';
import type { Config } from './lib/config.js';

export type Screen = 'chat' | 'model-selector' | 'conversations' | 'provider-selector';

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

  // Palette commands — registered here at App level so they have access to navigation state
  const paletteCommands: PaletteCommand[] = [
    {
      id: 'model-selector', name: 'Switch model', shortcut: '/model',
      description: 'Choose a different Ollama model', group: 'chat',
      execute: () => setCurrentScreen('model-selector'),
    },
    {
      id: 'provider-selector', name: 'Switch provider', shortcut: '/provider',
      description: 'Choose a different provider profile', group: 'chat',
      execute: () => setCurrentScreen('provider-selector'),
    },
    {
      id: 'conversations', name: 'Conversation history', shortcut: 'Ctrl+L',
      description: 'Browse and resume past conversations', group: 'chat',
      execute: () => setCurrentScreen('conversations'),
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
      id: 'tpl-code-review', name: 'Template: Code Reviewer',
      description: 'Switch to code review persona', group: 'templates',
      execute: () => handleNavigate('template:code-reviewer'),
    },
    {
      id: 'tpl-refactor', name: 'Template: Refactoring Partner',
      description: 'Switch to refactoring persona', group: 'templates',
      execute: () => handleNavigate('template:refactoring-partner'),
    },
    {
      id: 'tpl-debug', name: 'Template: Debug Assistant',
      description: 'Switch to debug persona', group: 'templates',
      execute: () => handleNavigate('template:debug-assistant'),
    },
    {
      id: 'tpl-clear', name: 'Clear template',
      description: 'Remove active system prompt template', group: 'templates',
      execute: () => handleNavigate('template:clear'),
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
          initialModel={activeModel}
          {...(resumeConversationId !== undefined ? { resumeConversationId } : {})}
          {...(projectDir !== undefined ? { projectDir } : {})}
          {...(config !== undefined ? { config } : {})}
          {...(activeProvider !== null ? {
            overrideBaseUrl: activeProvider.baseUrl,
            overrideApiKey: activeProvider.apiKey,
          } : {})}
          onNavigate={handleNavigate}
          onError={handleError}
          onCommand={handleNavigate}
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
          onSelect={() => setCurrentScreen('chat')}
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
        />
      )}
    </Box>
  );
}
