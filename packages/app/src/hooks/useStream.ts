import { useState, useCallback, useRef, useEffect } from 'react';
import { streamText } from 'ai';
import type { LanguageModel, CoreMessage, Tool } from 'ai';
import type { UplnkError } from 'uplnk-shared';
import { toUplnkError } from '../lib/errors.js';

export type StreamStatus =
  | 'idle'
  | 'connecting'
  | 'streaming'
  | 'tool-running'
  | 'done'
  | 'error';

export interface SendOptions {
  /**
   * If provided, onPersist is called with the full accumulated text
   * every PERSIST_INTERVAL_MS during streaming, and once more on final flush.
   * The caller (ChatScreen) is responsible for writing to SQLite.
   *
   * C1 incremental persistence fix: an empty assistant row is inserted before
   * streaming starts, then updated as chunks arrive so a SIGKILL mid-stream
   * leaves partial text visible on next open.
   */
  onPersist?: (text: string) => void;
  /**
   * When provided by the ModelRouter, use this pre-built LanguageModel instead
   * of the hook's default model for this single request.  The caller (ChatScreen)
   * is responsible for constructing the LanguageModel from the routed model ID
   * before passing it here.
   */
  modelOverride?: LanguageModel;
}

interface UseStreamResult {
  streamedText: string;
  status: StreamStatus;
  activeToolName: string | null;
  error: UplnkError | null;
  send: (messages: CoreMessage[], tools?: Record<string, Tool>, opts?: SendOptions) => Promise<void>;
  abort: () => void;
  reset: () => void;
}

// Flush cadence for the streaming text buffer. At ~30fps, the perceived
// smoothness matches Claude Code / Gemini CLI while cutting React reconciler
// work by ~10x when a hot Ollama model emits 60+ tokens/sec. Dropping below
// ~24fps is noticeably choppy; going above ~60fps wastes work since Ink's
// full-string diff dominates render cost.
const FLUSH_INTERVAL_MS = 33;

// Persistence cadence — how often we call onPersist during streaming.
// 500ms means at most 2 SQLite writes/second regardless of token rate.
// The final flush is always synchronous (called after stopFlushTimer).
const PERSIST_INTERVAL_MS = 500;

export function useStream(model: LanguageModel): UseStreamResult {
  const [streamedText, setStreamedText] = useState('');
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [activeToolName, setActiveToolName] = useState<string | null>(null);
  const [error, setError] = useState<UplnkError | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Tokens are accumulated here between flushes so we don't fire a React
  // re-render on every chunk. The ref is the source of truth during a
  // stream — state lags by at most FLUSH_INTERVAL_MS.
  const streamBufferRef = useRef('');
  // Full accumulated text for persistence — separate from React state so
  // the persist timer always has the latest text without a stale closure.
  const accumulatedTextRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const persistTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopFlushTimer = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  const stopPersistTimer = useCallback(() => {
    if (persistTimerRef.current !== null) {
      clearInterval(persistTimerRef.current);
      persistTimerRef.current = null;
    }
  }, []);

  const send = useCallback(
    async (messages: CoreMessage[], tools?: Record<string, Tool>, opts?: SendOptions) => {
      abortControllerRef.current?.abort();
      stopFlushTimer();
      stopPersistTimer();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      streamBufferRef.current = '';
      accumulatedTextRef.current = '';
      setStreamedText('');
      setActiveToolName(null);
      setStatus('connecting');
      setError(null);

      const { onPersist, modelOverride } = opts ?? {};
      // When the ModelRouter has selected a specific model for this request,
      // use it instead of the hook-level default.  Falls back to the hook's
      // model when routing is disabled or no override was provided.
      const effectiveModel = modelOverride ?? model;

      try {
        const { fullStream } = streamText({
          model: effectiveModel,
          messages,
          ...(tools !== undefined ? { tools } : {}),
          abortSignal: controller.signal,
          maxSteps: 5,
        });

        setStatus('streaming');

        // Start the UI flush interval. It appends whatever has been buffered
        // since the last tick in one setState, producing at most ~30 React
        // re-renders per second regardless of upstream token rate.
        flushTimerRef.current = setInterval(() => {
          if (streamBufferRef.current.length === 0) return;
          const buffered = streamBufferRef.current;
          streamBufferRef.current = '';
          setStreamedText((prev) => prev + buffered);
        }, FLUSH_INTERVAL_MS);

        // Start the persistence interval — writes buffered text to SQLite
        // at a lower cadence so the DB is not hammered on every token.
        if (onPersist !== undefined) {
          persistTimerRef.current = setInterval(() => {
            const text = accumulatedTextRef.current;
            if (text.length > 0) {
              onPersist(text);
            }
          }, PERSIST_INTERVAL_MS);
        }

        for await (const event of fullStream) {
          if (controller.signal.aborted) break;

          switch (event.type) {
            case 'text-delta':
              // Accumulate text tokens in both the UI buffer and the persist ref
              streamBufferRef.current += event.textDelta;
              accumulatedTextRef.current += event.textDelta;
              break;

            case 'tool-call':
              // A tool call has been dispatched — surface "tool-running" status
              // with the tool name for the StatusBar to display.
              setActiveToolName(event.toolName);
              setStatus('tool-running');
              break;

            case 'step-finish':
              // A step (potentially including tool execution) completed —
              // return to streaming so the StatusBar clears the tool name.
              setActiveToolName(null);
              setStatus('streaming');
              break;

            case 'error':
              // Propagate stream-level errors
              throw event.error instanceof Error
                ? event.error
                : new Error(String(event.error));

            // Remaining event types (step-start, finish, etc.)
            // do not require UI reactions — intentionally ignored.
            default:
              break;
          }
        }

        // Final synchronous flush: guarantees the last tokens are committed
        // before we transition to 'done'. Without this, a message shorter
        // than one flush interval could end with empty state.
        stopFlushTimer();
        stopPersistTimer();

        if (streamBufferRef.current.length > 0) {
          const buffered = streamBufferRef.current;
          streamBufferRef.current = '';
          setStreamedText((prev) => prev + buffered);
        }

        // Final persist — synchronous, captures any tokens since the last tick.
        if (onPersist !== undefined && accumulatedTextRef.current.length > 0) {
          onPersist(accumulatedTextRef.current);
        }

        setActiveToolName(null);
        setStatus('done');
      } catch (err) {
        stopFlushTimer();
        stopPersistTimer();
        // On error/abort, persist whatever we have so partial text is not lost.
        if (onPersist !== undefined && accumulatedTextRef.current.length > 0) {
          onPersist(accumulatedTextRef.current);
        }
        streamBufferRef.current = '';
        setActiveToolName(null);
        if ((err as Error).name === 'AbortError') {
          setStatus('idle');
          return;
        }
        setError(toUplnkError(err));
        setStatus('error');
      }
    },
    [model, stopFlushTimer, stopPersistTimer],
  );

  const abort = useCallback(() => {
    abortControllerRef.current?.abort();
    stopFlushTimer();
    stopPersistTimer();
    streamBufferRef.current = '';
    accumulatedTextRef.current = '';
    setStreamedText('');
    setActiveToolName(null);
    setStatus('idle');
  }, [stopFlushTimer, stopPersistTimer]);

  const reset = useCallback(() => {
    abortControllerRef.current?.abort();
    stopFlushTimer();
    stopPersistTimer();
    streamBufferRef.current = '';
    accumulatedTextRef.current = '';
    setStreamedText('');
    setActiveToolName(null);
    setStatus('idle');
    setError(null);
  }, [stopFlushTimer, stopPersistTimer]);

  // Abort any active stream when the component unmounts (e.g. Ctrl+C exit),
  // so the Ollama HTTP connection is closed and the event loop can drain.
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      if (flushTimerRef.current !== null) {
        clearInterval(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      if (persistTimerRef.current !== null) {
        clearInterval(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, []);

  return { streamedText, status, activeToolName, error, send, abort, reset };
}
