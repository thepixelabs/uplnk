/**
 * useCompare — drives N parallel streams against N models for the /compare
 * mode introduced in Phase E.2.4.
 *
 * Design notes
 *  - Each pane streams INDEPENDENTLY via streamText from 'ai'. We mirror
 *    useStream.ts's ref-buffer pattern (per-pane buffered text in a ref,
 *    flushed at ~30fps) so a hot pane doesn't force a full-component
 *    re-render on every chunk and starve the other panes.
 *  - Per-pane state lives in a single useState<ComparePaneState[]> — pane
 *    list length is fixed at hook construction by opts.models, so the
 *    array shape is stable across renders.
 *  - Parallel mode: Promise.all over all panes.
 *  - Sequential mode: a plain for-loop; non-active panes stay 'waiting'
 *    so the screen can dim them while the active pane streams.
 *  - AbortControllers stored per-pane in a ref, so abortAll() can fire
 *    them all without scheduling a render.
 *  - Blind mode: panes get labels 'A', 'B', … on construction. The
 *    reveal() flip switches displayLabel to the real model id; submit()
 *    re-blinds when opts.blind is true (a new round is a new blind round).
 *  - Vote persistence is delegated to lib/compareScoreboard — this hook
 *    only buffers the current turn's prompt and calls writeVote() with
 *    the recorded models[] in pane-index order.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { streamText } from 'ai';
import type { CoreMessage, LanguageModel } from 'ai';
import type { UplnkError } from '@uplnk/shared';
import { toUplnkError } from '../lib/errors.js';
import { sanitizeMessages } from '../lib/sanitizeMessages.js';
import {
  readVotes,
  writeVote,
  aggregateScoreboard,
  COMPARE_VOTE_SCHEMA_VERSION,
  type CompareAggregateRow,
  type CompareVoteRecord,
} from '../lib/compareScoreboard.js';

export type ComparePaneStatus =
  | 'idle'
  | 'waiting'
  | 'streaming'
  | 'done'
  | 'error'
  | 'aborted';

export interface ComparePaneState {
  /** Position of this pane in opts.models, also the vote winner index. */
  index: number;
  model: LanguageModel;
  modelId: string;
  /** 'A' / 'B' / … in blind mode, modelId when revealed. */
  displayLabel: string;
  messages: CoreMessage[];
  streamedText: string;
  status: ComparePaneStatus;
  error: UplnkError | null;
  /** ms since the round started until the first text-delta arrived. */
  firstTokenMs: number | null;
  /** ms since the round started until the stream finished or errored. */
  finishMs: number | null;
}

export interface UseCompareOptions {
  models: ReadonlyArray<{ languageModel: LanguageModel; modelId: string }>;
  /** Default true. New submits re-blind. */
  blind?: boolean;
  /** Default true. When false, panes stream one-at-a-time in pane order. */
  parallel?: boolean;
  /** Mode tag persisted with each vote — defaults to 'chat'. */
  mode?: 'chat' | 'research';
  /** Override the votes file path; defaults to ~/.uplnk/compare-votes.json. */
  scoreboardPath?: string;
}

export interface UseCompareResult {
  panes: readonly ComparePaneState[];
  /** Send the same prompt to all panes. */
  submit: (prompt: string) => Promise<void>;
  /** Abort every in-flight stream. */
  abortAll: () => void;
  /** Record a vote for the current turn and append to disk. */
  vote: (winner: number | 'tie') => void;
  /** Reveal real model ids in blind mode. Non-persistent. */
  reveal: () => void;
  /** True while any pane has an in-flight stream (waiting or streaming). */
  isStreaming: boolean;
  /** Aggregated scoreboard from disk, refreshed after each vote. */
  scoreboard: CompareAggregateRow[];
  /** True when display labels are currently hidden (A/B/C…). */
  blinded: boolean;
  /** Prompt of the most recent submit() (used by the screen as a header). */
  currentPrompt: string;
}

// Flush cadence — matches useStream so a hot pane delivers ~30fps token batches
// without thrashing the React tree. The whole hook publishes one setState per
// flush regardless of pane count, so a 4-pane compare costs the same render
// budget as a 2-pane one.
const FLUSH_INTERVAL_MS = 33;

// Pane label alphabet. Caps at 8 panes because the screen's keybind map
// (v/b/c/d/e/f/g/h) follows the same upper bound.
const PANE_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;
export const MAX_COMPARE_PANES = PANE_LABELS.length;

interface PaneRuntime {
  controller: AbortController | null;
  buffer: string;
  accumulated: string;
  firstTokenAt: number | null;
}

function makeInitialPane(
  index: number,
  modelId: string,
  model: LanguageModel,
  blinded: boolean,
): ComparePaneState {
  return {
    index,
    model,
    modelId,
    displayLabel: blinded ? PANE_LABELS[index] ?? `P${index}` : modelId,
    messages: [],
    streamedText: '',
    status: 'idle',
    error: null,
    firstTokenMs: null,
    finishMs: null,
  };
}

export function useCompare(opts: UseCompareOptions): UseCompareResult {
  const {
    models,
    blind = true,
    parallel = true,
    mode = 'chat',
    scoreboardPath,
  } = opts;

  if (models.length === 0) {
    throw new Error('useCompare requires at least one model');
  }
  if (models.length > MAX_COMPARE_PANES) {
    throw new Error(
      `useCompare supports at most ${String(MAX_COMPARE_PANES)} panes (got ${String(models.length)})`,
    );
  }

  const [blinded, setBlinded] = useState<boolean>(blind);
  const [panes, setPanes] = useState<ComparePaneState[]>(() =>
    models.map((m, i) => makeInitialPane(i, m.modelId, m.languageModel, blind)),
  );
  const [scoreboard, setScoreboard] = useState<CompareAggregateRow[]>(() =>
    aggregateScoreboard(readVotes(scoreboardPath)),
  );
  const [currentPrompt, setCurrentPrompt] = useState<string>('');

  // Per-pane runtime — held in refs so token arrivals never schedule a render.
  const runtimesRef = useRef<PaneRuntime[]>(
    models.map(() => ({
      controller: null,
      buffer: '',
      accumulated: '',
      firstTokenAt: null,
    })),
  );

  // Single flush timer drains every pane's buffer in one setState — cheaper
  // than N timers and avoids cross-pane render thrash.
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Counts panes currently in 'waiting' or 'streaming'. Drops to 0 → stop the
  // flush timer. Kept as a ref because the timer body needs the live value.
  const liveCountRef = useRef<number>(0);

  const stopFlushTimer = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  const flushOnce = useCallback(() => {
    const runtimes = runtimesRef.current;
    let dirty = false;
    for (const rt of runtimes) {
      if (rt.buffer.length > 0) {
        dirty = true;
        break;
      }
    }
    if (!dirty) return;
    setPanes((prev) =>
      prev.map((pane, i) => {
        const rt = runtimes[i];
        if (rt === undefined || rt.buffer.length === 0) return pane;
        const buffered = rt.buffer;
        rt.buffer = '';
        return { ...pane, streamedText: pane.streamedText + buffered };
      }),
    );
  }, []);

  const ensureFlushTimer = useCallback(() => {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = setInterval(() => {
      flushOnce();
      if (liveCountRef.current === 0) {
        // Drain done — synchronous final flush already handled by streamPane,
        // safe to stop the timer until the next submit.
        stopFlushTimer();
      }
    }, FLUSH_INTERVAL_MS);
  }, [flushOnce, stopFlushTimer]);

  const setPaneStatus = useCallback(
    (index: number, patch: Partial<ComparePaneState>) => {
      setPanes((prev) =>
        prev.map((pane, i) => (i === index ? { ...pane, ...patch } : pane)),
      );
    },
    [],
  );

  const streamPane = useCallback(
    async (
      index: number,
      model: LanguageModel,
      messages: CoreMessage[],
      turnStartMs: number,
    ) => {
      const runtimes = runtimesRef.current;
      const rt = runtimes[index];
      if (rt === undefined) return;
      const controller = new AbortController();
      rt.controller = controller;
      rt.buffer = '';
      rt.accumulated = '';
      rt.firstTokenAt = null;

      liveCountRef.current += 1;
      ensureFlushTimer();
      setPaneStatus(index, {
        status: 'waiting',
        streamedText: '',
        error: null,
        firstTokenMs: null,
        finishMs: null,
      });

      const sanitised = sanitizeMessages(messages);

      try {
        const { fullStream } = streamText({
          model,
          messages: sanitised,
          abortSignal: controller.signal,
        });

        let sawFirstToken = false;
        for await (const event of fullStream) {
          if (controller.signal.aborted) break;
          switch (event.type) {
            case 'text-delta': {
              if (!sawFirstToken) {
                sawFirstToken = true;
                rt.firstTokenAt = Date.now();
                setPaneStatus(index, {
                  status: 'streaming',
                  firstTokenMs: rt.firstTokenAt - turnStartMs,
                });
              }
              rt.buffer += event.textDelta;
              rt.accumulated += event.textDelta;
              break;
            }
            case 'error':
              throw event.error instanceof Error ? event.error : new Error(String(event.error));
            default:
              break;
          }
        }

        // Final sync flush so the last batch of tokens lands before 'done'.
        flushOnce();

        liveCountRef.current = Math.max(0, liveCountRef.current - 1);
        const finishMs = Date.now() - turnStartMs;
        // Promote the streamed text into the pane's messages history so a
        // follow-up submit() in the same hook instance can include prior turns.
        setPanes((prev) =>
          prev.map((pane, i) => {
            if (i !== index) return pane;
            const assistantMessage: CoreMessage = {
              role: 'assistant',
              content: rt.accumulated,
            };
            return {
              ...pane,
              status: 'done',
              streamedText: rt.accumulated,
              finishMs,
              messages: [...pane.messages, ...messages.slice(pane.messages.length), assistantMessage],
            };
          }),
        );
      } catch (err) {
        flushOnce();
        liveCountRef.current = Math.max(0, liveCountRef.current - 1);
        if ((err as Error).name === 'AbortError') {
          setPaneStatus(index, {
            status: 'aborted',
            streamedText: rt.accumulated,
            finishMs: Date.now() - turnStartMs,
          });
          return;
        }
        setPaneStatus(index, {
          status: 'error',
          error: toUplnkError(err),
          streamedText: rt.accumulated,
          finishMs: Date.now() - turnStartMs,
        });
      }
    },
    [ensureFlushTimer, flushOnce, setPaneStatus],
  );

  const submit = useCallback(
    async (prompt: string) => {
      // Re-blind on every new round when the user requested blind mode.
      if (blind) setBlinded(true);
      setCurrentPrompt(prompt);

      // Reset pane state for the new turn but preserve the conversation
      // history so multi-turn compares stay coherent.
      setPanes((prev) =>
        prev.map((pane) => ({
          ...pane,
          displayLabel: blind ? PANE_LABELS[pane.index] ?? `P${pane.index}` : pane.modelId,
          status: 'waiting',
          streamedText: '',
          error: null,
          firstTokenMs: null,
          finishMs: null,
        })),
      );

      const turnStartMs = Date.now();
      const messagesByPane: CoreMessage[][] = panes.map((pane) => [
        ...pane.messages,
        { role: 'user', content: prompt },
      ]);

      if (parallel) {
        await Promise.all(
          models.map((m, i) => {
            const turnMessages = messagesByPane[i] ?? [{ role: 'user', content: prompt }];
            return streamPane(i, m.languageModel, turnMessages, turnStartMs);
          }),
        );
      } else {
        for (let i = 0; i < models.length; i++) {
          const m = models[i];
          if (m === undefined) continue;
          const turnMessages = messagesByPane[i] ?? [{ role: 'user', content: prompt }];
          await streamPane(i, m.languageModel, turnMessages, turnStartMs);
        }
      }
    },
    [blind, models, panes, parallel, streamPane],
  );

  const abortAll = useCallback(() => {
    for (const rt of runtimesRef.current) {
      rt.controller?.abort();
    }
    // Stream loops handle their own state transitions on abort. The flush
    // timer is stopped lazily when liveCountRef hits zero.
  }, []);

  const vote = useCallback(
    (winner: number | 'tie') => {
      if (currentPrompt.length === 0) return;
      const record: CompareVoteRecord = {
        schemaVersion: COMPARE_VOTE_SCHEMA_VERSION,
        ts: new Date().toISOString(),
        models: models.map((m) => m.modelId),
        winner,
        prompt: currentPrompt,
        mode,
        blind: blinded,
      };
      writeVote(record, scoreboardPath);
      setScoreboard(aggregateScoreboard(readVotes(scoreboardPath)));
    },
    [blinded, currentPrompt, mode, models, scoreboardPath],
  );

  const reveal = useCallback(() => {
    setBlinded(false);
    setPanes((prev) => prev.map((pane) => ({ ...pane, displayLabel: pane.modelId })));
  }, []);

  // Tear down any leftover controllers + timers on unmount so a screen
  // teardown mid-stream does not leak HTTP connections.
  useEffect(() => {
    return () => {
      for (const rt of runtimesRef.current) {
        rt.controller?.abort();
      }
      if (flushTimerRef.current !== null) {
        clearInterval(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, []);

  const isStreaming = useMemo(
    () => panes.some((p) => p.status === 'streaming' || p.status === 'waiting'),
    [panes],
  );

  return {
    panes,
    submit,
    abortAll,
    vote,
    reveal,
    isStreaming,
    scoreboard,
    blinded,
    currentPrompt,
  };
}
