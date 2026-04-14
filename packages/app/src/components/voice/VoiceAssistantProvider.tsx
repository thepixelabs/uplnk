import React, { createContext, useContext, useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { voskService } from '../../lib/voice/VoskService.js';
import { ensureModelExists } from '../../lib/voice/modelLoader.js';

interface VoiceAssistantContextType {
  isInitialized: boolean;
  isDictating: boolean;
  partialTranscription: string;
  startDictation: () => void | Promise<void>;
  stopDictation: () => void;
  toggleDictation: () => void;
  registerTranscriptionHandler: (cb: (text: string) => void) => () => void;
  error: string | null;
  statusMessage: string | null;
}

const VoiceAssistantContext = createContext<VoiceAssistantContextType | null>(null);

export const useVoiceAssistant = () => {
  const context = useContext(VoiceAssistantContext);
  if (!context) {
    throw new Error('useVoiceAssistant must be used within a VoiceAssistantProvider');
  }
  return context;
};

interface Props {
  children: React.ReactNode;
  onCommand?: (command: VoiceCommand) => void;
}

export type VoiceCommand =
  | { type: 'CHANGE_PROVIDER'; providerName: string }
  | { type: 'SWITCH_MODEL'; modelName: string }
  | { type: 'CLEAR_CHAT' };

export const VoiceAssistantProvider: React.FC<Props> = ({ children, onCommand }) => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [isDictating, setIsDictating] = useState(false);
  const [partialTranscription, setPartialTranscription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const isInitializingRef = useRef(false);
  
  // Set of callbacks for final dictation results
  const transcriptionHandlersRef = useRef<Set<(text: string) => void>>(new Set());

  const registerTranscriptionHandler = useCallback((cb: (text: string) => void) => {
    transcriptionHandlersRef.current.add(cb);
    return () => {
      transcriptionHandlersRef.current.delete(cb);
    };
  }, []);

  const modeRef = useRef<'idle' | 'wakeword' | 'dictation'>('idle');

  useEffect(() => {
    const handleFinalResult = (text: string) => {
      if (modeRef.current === 'wakeword') {
        const trimmed = text.toLowerCase();
        if (trimmed.includes('linky')) {
          const commandText = text.slice(trimmed.indexOf('linky') + 5).trim();
          if (commandText) {
            parseAndExecuteCommand(commandText);
          }
        }
      } else if (modeRef.current === 'dictation') {
        // Notify all registered handlers (e.g. ChatInput)
        transcriptionHandlersRef.current.forEach(handler => handler(text));
        setPartialTranscription('');
      }
    };

    const handlePartialResult = (partial: string) => {
      if (modeRef.current === 'dictation') {
        setPartialTranscription(partial);
      }
    };

    voskService.on('finalResult', handleFinalResult);
    voskService.on('partialResult', handlePartialResult);

    return () => {
      voskService.off('finalResult', handleFinalResult);
      voskService.off('partialResult', handlePartialResult);
      voskService.destroy();
    };
  }, []);

  const parseAndExecuteCommand = (text: string) => {
    const lower = text.toLowerCase();
    
    const providerMatch = lower.match(/(?:please )?change provider to (.+)/i) || 
                          lower.match(/(?:please )?switch provider to (.+)/i);
    if (providerMatch && providerMatch[1]) {
      onCommand?.({ type: 'CHANGE_PROVIDER', providerName: providerMatch[1] });
      return;
    }

    const modelMatch = lower.match(/(?:please )?switch model to (.+)/i) || 
                       lower.match(/(?:please )?change model to (.+)/i);
    if (modelMatch && modelMatch[1]) {
      onCommand?.({ type: 'SWITCH_MODEL', modelName: modelMatch[1] });
      return;
    }

    if (lower.includes('clear chat') || lower.includes('clear conversation')) {
      onCommand?.({ type: 'CLEAR_CHAT' });
      return;
    }
  };

  const initVoice = useCallback(async (): Promise<boolean> => {
    if (isInitialized) return true;
    if (isInitializingRef.current) return false;
    isInitializingRef.current = true;
    try {
      setStatusMessage('Checking voice model...');
      await ensureModelExists((msg) => setStatusMessage(msg));
      await voskService.initialize();
      setIsInitialized(true);
      setStatusMessage(null);
      return true;
    } catch (err: any) {
      setError(err.message as string);
      setStatusMessage(null);
      return false;
    } finally {
      isInitializingRef.current = false;
    }
  }, [isInitialized]);

  const startDictation = useCallback(async () => {
    const ready = await initVoice();
    if (!ready) return;
    modeRef.current = 'dictation';
    voskService.startListening();
    setIsDictating(true);
    setPartialTranscription('');
  }, [initVoice]);

  const stopDictation = useCallback(() => {
    modeRef.current = 'idle';
    voskService.stopListening();
    setIsDictating(false);
    setPartialTranscription('');
  }, []);

  const toggleDictation = useCallback(() => {
    if (isDictating) {
      stopDictation();
    } else {
      void startDictation();
    }
  }, [isDictating, startDictation, stopDictation]);

  const contextValue = useMemo(() => ({
    isInitialized,
    isDictating,
    partialTranscription,
    startDictation,
    stopDictation,
    toggleDictation,
    registerTranscriptionHandler,
    error,
    statusMessage,
  }), [isInitialized, isDictating, partialTranscription, startDictation, stopDictation, toggleDictation, registerTranscriptionHandler, error, statusMessage]);

  return (
    <VoiceAssistantContext.Provider value={contextValue}>
      {children}
    </VoiceAssistantContext.Provider>
  );
};
