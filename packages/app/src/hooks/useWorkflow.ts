import { useState, useCallback, useRef, useEffect } from 'react';
import { randomUUID } from 'node:crypto';
import {
  db,
  createRelayRun,
  updateRelayRun,
  getProviderById,
  createConversation,
  insertMessage,
} from 'uplnk-db';
import { createLanguageModel } from '../lib/languageModelFactory.js';
import { resolveSecret } from '../lib/secrets.js';
import { runRelay } from '../lib/workflows/workflowEngine.js';
import { RelayError } from '../lib/workflows/errors.js';
import type { RelayPlan } from '../lib/workflows/planSchema.js';

export type RelayStatus =
  | 'idle'
  | 'scout-running'
  | 'scout-done'
  | 'anchor-running'
  | 'completed'
  | 'error';

export interface UseWorkflowResult {
  scoutText: string;
  anchorText: string;
  status: RelayStatus;
  error: RelayError | null;
  runRelayPlan: (plan: RelayPlan, userInput: string) => Promise<void>;
  abort: () => void;
  reset: () => void;
}

// Flush cadence for the streaming text buffer — matches useStream at ~30fps.
// Cutting React reconciler work by ~10x at typical Ollama token rates.
const FLUSH_INTERVAL_MS = 33;

export function useWorkflow(): UseWorkflowResult {
  const [scoutText, setScoutText] = useState('');
  const [anchorText, setAnchorText] = useState('');
  const [status, setStatus] = useState<RelayStatus>('idle');
  const [error, setError] = useState<RelayError | null>(null);

  // Separate buffers and flush timers for the two phases so each phase has
  // independent backpressure without coupling their timer lifecycles.
  const scoutBufferRef = useRef('');
  const anchorBufferRef = useRef('');
  const scoutFlushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const anchorFlushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Full accumulated text — the source of truth for DB persistence since the
  // React state lags by up to FLUSH_INTERVAL_MS.
  const accumulatedScoutRef = useRef('');
  const accumulatedAnchorRef = useRef('');

  const abortControllerRef = useRef<AbortController | null>(null);
  const runIdRef = useRef<string | null>(null);

  // ── Timer helpers ──────────────────────────────────────────────────────────

  const stopScoutFlushTimer = useCallback(() => {
    if (scoutFlushTimerRef.current !== null) {
      clearInterval(scoutFlushTimerRef.current);
      scoutFlushTimerRef.current = null;
    }
  }, []);

  const stopAnchorFlushTimer = useCallback(() => {
    if (anchorFlushTimerRef.current !== null) {
      clearInterval(anchorFlushTimerRef.current);
      anchorFlushTimerRef.current = null;
    }
  }, []);

  const startScoutFlushTimer = useCallback(() => {
    scoutFlushTimerRef.current = setInterval(() => {
      if (scoutBufferRef.current.length === 0) return;
      const buffered = scoutBufferRef.current;
      scoutBufferRef.current = '';
      setScoutText((prev) => prev + buffered);
    }, FLUSH_INTERVAL_MS);
  }, []);

  const startAnchorFlushTimer = useCallback(() => {
    anchorFlushTimerRef.current = setInterval(() => {
      if (anchorBufferRef.current.length === 0) return;
      const buffered = anchorBufferRef.current;
      anchorBufferRef.current = '';
      setAnchorText((prev) => prev + buffered);
    }, FLUSH_INTERVAL_MS);
  }, []);

  // Final synchronous flush — drains whatever remains in the buffer before
  // we stop the timer so we never drop the last tokens of a phase.
  const finalFlushScout = useCallback(() => {
    stopScoutFlushTimer();
    if (scoutBufferRef.current.length > 0) {
      const buffered = scoutBufferRef.current;
      scoutBufferRef.current = '';
      setScoutText((prev) => prev + buffered);
    }
  }, [stopScoutFlushTimer]);

  const finalFlushAnchor = useCallback(() => {
    stopAnchorFlushTimer();
    if (anchorBufferRef.current.length > 0) {
      const buffered = anchorBufferRef.current;
      anchorBufferRef.current = '';
      setAnchorText((prev) => prev + buffered);
    }
  }, [stopAnchorFlushTimer]);

  // ── Core runner ────────────────────────────────────────────────────────────

  const runRelayPlan = useCallback(
    async (plan: RelayPlan, userInput: string): Promise<void> => {
      // Cancel any in-flight relay before starting a new one.
      abortControllerRef.current?.abort();
      stopScoutFlushTimer();
      stopAnchorFlushTimer();

      const controller = new AbortController();
      abortControllerRef.current = controller;

      // Reset all state
      scoutBufferRef.current = '';
      anchorBufferRef.current = '';
      accumulatedScoutRef.current = '';
      accumulatedAnchorRef.current = '';
      setScoutText('');
      setAnchorText('');
      setError(null);
      setStatus('scout-running');

      // ── Resolve providers ────────────────────────────────────────────────
      const scoutProvider = getProviderById(db, plan.scout.providerId);
      if (scoutProvider === undefined) {
        const err = new RelayError(
          'RELAY_PROVIDER_NOT_FOUND',
          `Scout provider not found: ${plan.scout.providerId}`,
        );
        setError(err);
        setStatus('error');
        return;
      }

      const anchorProvider = getProviderById(db, plan.anchor.providerId);
      if (anchorProvider === undefined) {
        const err = new RelayError(
          'RELAY_PROVIDER_NOT_FOUND',
          `Anchor provider not found: ${plan.anchor.providerId}`,
        );
        setError(err);
        setStatus('error');
        return;
      }

      // ── Resolve API keys ─────────────────────────────────────────────────
      const scoutApiKey = resolveSecret(scoutProvider.apiKey) ?? '';
      const anchorApiKey = resolveSecret(anchorProvider.apiKey) ?? '';

      // ── Build language models ────────────────────────────────────────────
      const scoutModel = createLanguageModel({
        providerType: scoutProvider.providerType,
        baseURL: scoutProvider.baseUrl,
        apiKey: scoutApiKey,
        modelId: plan.scout.model,
      });

      const anchorModel = createLanguageModel({
        providerType: anchorProvider.providerType,
        baseURL: anchorProvider.baseUrl,
        apiKey: anchorApiKey,
        modelId: plan.anchor.model,
      });

      // ── Create relay_run record ──────────────────────────────────────────
      const runId = randomUUID();
      createRelayRun(db, {
        id: runId,
        relayId: plan.id,
        relayName: plan.name,
        input: userInput,
        scoutProviderId: plan.scout.providerId,
        scoutModel: plan.scout.model,
        anchorProviderId: plan.anchor.providerId,
        anchorModel: plan.anchor.model,
        status: 'running',
      });
      runIdRef.current = runId;

      // ── Start scout flush timer ──────────────────────────────────────────
      startScoutFlushTimer();

      // ── Drive the engine ─────────────────────────────────────────────────
      try {
        for await (const event of runRelay({ plan, scoutModel, anchorModel, userInput, signal: controller.signal })) {
          if (controller.signal.aborted) break;

          switch (event.type) {
            case 'scout:start':
              setStatus('scout-running');
              break;

            case 'scout:delta':
              scoutBufferRef.current += event.text;
              accumulatedScoutRef.current += event.text;
              break;

            case 'scout:end': {
              finalFlushScout();
              setStatus('scout-done');
              // Persist scout output and token counts
              updateRelayRun(db, runId, {
                scoutOutput: event.fullText,
                scoutInputTokens: event.usage.inputTokens,
                scoutOutputTokens: event.usage.outputTokens,
              });
              // Start the anchor flush timer just before anchor:start arrives
              startAnchorFlushTimer();
              break;
            }

            case 'anchor:start':
              setStatus('anchor-running');
              break;

            case 'anchor:delta':
              anchorBufferRef.current += event.text;
              accumulatedAnchorRef.current += event.text;
              break;

            case 'anchor:end': {
              finalFlushAnchor();

              // ── Create conversation + messages in history ────────────────
              const conv = createConversation(db, {
                id: randomUUID(),
                title: plan.name,
                providerId: plan.anchor.providerId,
                modelId: plan.anchor.model,
                relayId: plan.id,
              });

              insertMessage(db, {
                id: randomUUID(),
                conversationId: conv.id,
                role: 'user',
                content: userInput,
              });

              // Store the scout output as a separate assistant message so
              // history shows both phases clearly.
              // Note: we intentionally omit inputTokens/outputTokens here.
              // The scout's token counts were already recorded on relay_runs
              // (scoutInputTokens/scoutOutputTokens) when scout:end fired.
              // Putting anchor counts on this message would double-count tokens
              // in any aggregate that sums message-level token columns.
              insertMessage(db, {
                id: randomUUID(),
                conversationId: conv.id,
                role: 'assistant',
                content: `[Scout analysis]\n${accumulatedScoutRef.current}`,
              });

              insertMessage(db, {
                id: randomUUID(),
                conversationId: conv.id,
                role: 'assistant',
                content: event.fullText,
                inputTokens: event.usage.inputTokens,
                outputTokens: event.usage.outputTokens,
              });

              updateRelayRun(db, runId, {
                anchorOutput: event.fullText,
                anchorInputTokens: event.usage.inputTokens,
                anchorOutputTokens: event.usage.outputTokens,
                status: 'completed',
                completedAt: new Date().toISOString(),
                conversationId: conv.id,
              });

              setStatus('completed');
              break;
            }

            case 'error': {
              finalFlushScout();
              finalFlushAnchor();
              const relayErr = event.error;

              updateRelayRun(db, runId, {
                status: relayErr.code === 'RELAY_ABORTED' ? 'cancelled' : 'failed',
                completedAt: new Date().toISOString(),
                errorMessage: relayErr.message,
              });

              if (relayErr.code === 'RELAY_ABORTED') {
                setStatus('idle');
              } else {
                setError(relayErr);
                setStatus('error');
              }
              return;
            }
          }
        }
      } catch (err) {
        // Unexpected throw from the generator — treat as a general failure.
        finalFlushScout();
        finalFlushAnchor();

        const relayErr =
          err instanceof RelayError
            ? err
            : new RelayError('RELAY_ANCHOR_FAILED', err instanceof Error ? err.message : String(err));

        updateRelayRun(db, runId, {
          status: 'failed',
          completedAt: new Date().toISOString(),
          errorMessage: relayErr.message,
        });

        setError(relayErr);
        setStatus('error');
      }
    },
    [
      stopScoutFlushTimer,
      stopAnchorFlushTimer,
      startScoutFlushTimer,
      startAnchorFlushTimer,
      finalFlushScout,
      finalFlushAnchor,
    ],
  );

  // ── Abort ──────────────────────────────────────────────────────────────────

  const abort = useCallback(() => {
    abortControllerRef.current?.abort();
    stopScoutFlushTimer();
    stopAnchorFlushTimer();
    scoutBufferRef.current = '';
    anchorBufferRef.current = '';
    setScoutText('');
    setAnchorText('');
    setStatus('idle');
  }, [stopScoutFlushTimer, stopAnchorFlushTimer]);

  // ── Reset ──────────────────────────────────────────────────────────────────

  const reset = useCallback(() => {
    abortControllerRef.current?.abort();
    stopScoutFlushTimer();
    stopAnchorFlushTimer();
    scoutBufferRef.current = '';
    anchorBufferRef.current = '';
    accumulatedScoutRef.current = '';
    accumulatedAnchorRef.current = '';
    setScoutText('');
    setAnchorText('');
    setStatus('idle');
    setError(null);
  }, [stopScoutFlushTimer, stopAnchorFlushTimer]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  // Abort the in-flight relay and drain timers when the component tree
  // unmounts (e.g. user exits with Ctrl+C) so we don't leak open HTTP
  // connections or intervals.

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      // Best-effort: mark any in-flight run as cancelled so the DB doesn't have stale 'running' rows
      if (runIdRef.current !== null) {
        try {
          updateRelayRun(db, runIdRef.current, {
            status: 'cancelled',
            completedAt: new Date().toISOString(),
          });
        } catch {
          // Best-effort — don't throw in cleanup
        }
        runIdRef.current = null;
      }
      if (scoutFlushTimerRef.current !== null) {
        clearInterval(scoutFlushTimerRef.current);
        scoutFlushTimerRef.current = null;
      }
      if (anchorFlushTimerRef.current !== null) {
        clearInterval(anchorFlushTimerRef.current);
        anchorFlushTimerRef.current = null;
      }
    };
  }, []);

  return { scoutText, anchorText, status, error, runRelayPlan, abort, reset };
}
