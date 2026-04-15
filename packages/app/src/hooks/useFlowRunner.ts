import { useState, useCallback, useRef } from 'react';
import { FlowEngine } from '../flow/engine/FlowEngine.js';
import type { FlowEvent } from '../flow/engine/FlowEngine.js';
import type { LoadedFlow } from '../flow/loader.js';
import type { FlowDef } from '../flow/schema.js';
import type { Config } from '../lib/config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type StepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

export interface FlowStepStatus {
  stepId: string;
  status: StepStatus;
  output?: unknown;
  /** Non-null only when status === 'error'. */
  error: string | null;
  /** Accumulated LLM stream text for chat steps. Non-null only for chat steps. */
  streamedText: string | null;
}

export type FlowRunnerStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

export interface FlowRunnerState {
  flow: FlowDef | null;
  loadedFlow: LoadedFlow | null;
  status: FlowRunnerStatus;
  currentStepId: string | null;
  stepStatuses: Record<string, FlowStepStatus>;
  events: FlowEvent[];
  /** Non-null only when status === 'error'. */
  error: string | null;
  /** Non-null only when status === 'done'. */
  output: Record<string, unknown> | null;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useFlowRunner(config: Config) {
  const [state, setState] = useState<FlowRunnerState>({
    flow: null,
    loadedFlow: null,
    status: 'idle',
    currentStepId: null,
    stepStatuses: {},
    events: [],
    error: null,
    output: null,
  });

  const abortRef = useRef<AbortController | null>(null);
  const engineRef = useRef<FlowEngine | null>(null);

  const load = useCallback((loaded: LoadedFlow) => {
    // Pre-populate step statuses so the UI can render all steps as 'pending'
    // immediately rather than waiting for the run to discover them.
    const stepStatuses: Record<string, FlowStepStatus> = {};
    for (const step of loaded.def.steps) {
      stepStatuses[step.id] = { stepId: step.id, status: 'pending', error: null, streamedText: null };
    }

    setState({
      flow: loaded.def,
      loadedFlow: loaded,
      status: 'idle',
      currentStepId: null,
      stepStatuses,
      events: [],
      error: null,
      output: null,
    });
  }, []);

  const run = useCallback(
    async (inputs?: Record<string, unknown>) => {
      const { loadedFlow } = state;
      if (loadedFlow === null) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const engine = new FlowEngine(config);
      engineRef.current = engine;

      setState((prev) => ({
        ...prev,
        status: 'running',
        currentStepId: null,
        events: [],
        error: null,
        output: null,
      }));

      const handleEvent = (event: FlowEvent): void => {
        setState((prev) => {
          const events = [...prev.events, event];
          let stepStatuses = prev.stepStatuses;
          let currentStepId = prev.currentStepId;

          switch (event.kind) {
            case 'step.start': {
              if (event.stepId !== undefined) {
                currentStepId = event.stepId;
                stepStatuses = {
                  ...stepStatuses,
                  [event.stepId]: {
                    stepId: event.stepId,
                    status: 'running',
                    error: null,
                    streamedText: '',
                  },
                };
              }
              break;
            }

            case 'step.done': {
              if (event.stepId !== undefined) {
                currentStepId = null;
                const existing = stepStatuses[event.stepId];
                stepStatuses = {
                  ...stepStatuses,
                  [event.stepId]: {
                    stepId: event.stepId,
                    status: 'done',
                    output: event.output,
                    error: null,
                    streamedText: existing?.streamedText ?? null,
                  },
                };
              }
              break;
            }

            case 'step.skip': {
              if (event.stepId !== undefined) {
                stepStatuses = {
                  ...stepStatuses,
                  [event.stepId]: {
                    stepId: event.stepId,
                    status: 'skipped',
                    error: null,
                    streamedText: null,
                  },
                };
              }
              break;
            }

            case 'step.error': {
              if (event.stepId !== undefined) {
                currentStepId = null;
                stepStatuses = {
                  ...stepStatuses,
                  [event.stepId]: {
                    stepId: event.stepId,
                    status: 'error',
                    error: event.error ?? 'Unknown error',
                    streamedText: null,
                  },
                };
              }
              break;
            }

            case 'step.stream': {
              if (event.stepId !== undefined && event.text !== undefined) {
                const existing = stepStatuses[event.stepId];
                stepStatuses = {
                  ...stepStatuses,
                  [event.stepId]: {
                    ...(existing ?? { stepId: event.stepId, status: 'running' as StepStatus, error: null }),
                    streamedText: ((existing?.streamedText ?? '') + event.text),
                  },
                };
              }
              break;
            }
          }

          return { ...prev, events, stepStatuses, currentStepId };
        });
      };

      const runInputs = inputs ?? {};

      try {
        const output = await engine.run(loadedFlow, {
          inputs: runInputs,
          onEvent: handleEvent,
          signal: controller.signal,
        });

        setState((prev) => ({ ...prev, status: 'done', output, currentStepId: null }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState((prev) => ({
          ...prev,
          status: controller.signal.aborted ? 'cancelled' : 'error',
          error: msg,
          currentStepId: null,
        }));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.loadedFlow, config],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState((prev) => ({ ...prev, status: 'cancelled', currentStepId: null }));
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState((prev) => {
      if (prev.loadedFlow === null) return prev;
      // Re-initialise step statuses to 'pending'
      const stepStatuses: Record<string, FlowStepStatus> = {};
      for (const step of prev.loadedFlow.def.steps) {
        stepStatuses[step.id] = { stepId: step.id, status: 'pending', error: null, streamedText: null };
      }
      return {
        ...prev,
        status: 'idle',
        currentStepId: null,
        stepStatuses,
        events: [],
        error: null,
        output: null,
      };
    });
  }, []);

  return { state, load, run, cancel, reset };
}
