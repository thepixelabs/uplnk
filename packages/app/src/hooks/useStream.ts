import { useState, useCallback, useRef } from 'react';
import { streamText } from 'ai';
import type { LanguageModel, CoreMessage, Tool } from 'ai';
import type { UplnkError } from 'uplnk-shared';
import { toUplnkError } from '../lib/errors.js';

export type StreamStatus =
  | 'idle'
  | 'connecting'
  | 'streaming'
  | 'done'
  | 'error';

interface UseStreamResult {
  streamedText: string;
  status: StreamStatus;
  error: UplnkError | null;
  send: (messages: CoreMessage[], tools?: Record<string, Tool>) => Promise<void>;
  abort: () => void;
  reset: () => void;
}

export function useStream(model: LanguageModel): UseStreamResult {
  const [streamedText, setStreamedText] = useState('');
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [error, setError] = useState<UplnkError | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (messages: CoreMessage[], tools?: Record<string, Tool>) => {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setStreamedText('');
      setStatus('connecting');
      setError(null);

      try {
        const { textStream } = streamText({
          model,
          messages,
          ...(tools !== undefined ? { tools } : {}),
          abortSignal: controller.signal,
          maxSteps: 10,
        });

        setStatus('streaming');

        for await (const chunk of textStream) {
          if (controller.signal.aborted) break;
          // Only StreamingMessage reads streamedText — no other component
          // re-renders on each token.
          setStreamedText((prev) => prev + chunk);
        }

        setStatus('done');
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          setStatus('idle');
          return;
        }
        setError(toUplnkError(err));
        setStatus('error');
      }
    },
    [model],
  );

  const abort = useCallback(() => {
    abortControllerRef.current?.abort();
    setStatus('idle');
  }, []);

  const reset = useCallback(() => {
    abortControllerRef.current?.abort();
    setStreamedText('');
    setStatus('idle');
    setError(null);
  }, []);

  return { streamedText, status, error, send, abort, reset };
}
