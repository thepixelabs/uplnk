import { useState, useCallback } from 'react';
import { Box, useApp, useInput } from 'ink';
import { ChatScreen } from './screens/ChatScreen.js';
import { ModelSelectorScreen } from './screens/ModelSelectorScreen.js';
import { ConversationListScreen } from './screens/ConversationListScreen.js';
import { ErrorBanner } from './components/layout/ErrorBanner.js';
import type { PylonError } from 'pylon-shared';

export type Screen = 'chat' | 'model-selector' | 'conversations';

export interface AppProps {
  initialModel?: string;
  initialProvider?: string;
  resumeConversationId?: string;
  subcommand: string;
}

export function App({ initialModel = 'llama3.2' }: AppProps) {
  const { exit } = useApp();
  const [currentScreen, setCurrentScreen] = useState<Screen>('chat');
  const [activeModel, setActiveModel] = useState(initialModel);
  const [globalError, setGlobalError] = useState<PylonError | null>(null);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { exit(); return; }
    if (key.ctrl && input === 'l') { setCurrentScreen('conversations'); return; }
    if (key.escape && currentScreen !== 'chat') { setCurrentScreen('chat'); return; }
  });

  const handleNavigate = useCallback((screen: string) => {
    setCurrentScreen(screen as Screen);
  }, []);

  const handleError = useCallback((error: PylonError) => {
    setGlobalError(error);
  }, []);

  return (
    <Box flexDirection="column" height="100%">
      {globalError && (
        <ErrorBanner error={globalError} onDismiss={() => setGlobalError(null)} />
      )}

      {currentScreen === 'chat' && (
        <ChatScreen
          initialModel={activeModel}
          onNavigate={handleNavigate}
          onError={handleError}
        />
      )}

      {currentScreen === 'model-selector' && (
        <ModelSelectorScreen
          onSelect={(model) => { setActiveModel(model); setCurrentScreen('chat'); }}
          onBack={() => setCurrentScreen('chat')}
        />
      )}

      {currentScreen === 'conversations' && (
        <ConversationListScreen
          onSelect={() => setCurrentScreen('chat')}
          onBack={() => setCurrentScreen('chat')}
        />
      )}
    </Box>
  );
}
