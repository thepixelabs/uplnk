/**
 * useAgentRun — React hook for running an agent invocation tree.
 *
 * Manages event accumulation, status transitions, and abort.
 * Exposes `rootInvocationId` so the render layer can pass it to AgentEventView.
 */

import { useState, useRef, useCallback } from 'react';
import type { CoreMessage } from 'ai';
import type { AgentDef, AgentEvent, RunAgentResult } from '../lib/agents/types.js';
import type { AgentOrchestrator } from '../lib/agents/orchestrator.js';
import type { AgentEventBus } from '../lib/agents/eventBus.js';

export type AgentRunStatus = 'idle' | 'running' | 'done' | 'error';

export interface UseAgentRunResult {
  events: AgentEvent[];
  status: AgentRunStatus;
  rootInvocationId: string;
  run: (agent: AgentDef, prompt: string, history: CoreMessage[]) => Promise<RunAgentResult>;
  abort: () => void;
}

export function useAgentRun(deps: {
  orchestrator: AgentOrchestrator;
  eventBus: AgentEventBus;
}): UseAgentRunResult {
  const { orchestrator, eventBus } = deps;

  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [status, setStatus] = useState<AgentRunStatus>('idle');
  const [rootInvocationId, setRootInvocationId] = useState('');

  const abortControllerRef = useRef<AbortController | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const abort = useCallback(() => {
    abortControllerRef.current?.abort();
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    setStatus('idle');
  }, []);

  const run = useCallback(
    async (agent: AgentDef, prompt: string, history: CoreMessage[]): Promise<RunAgentResult> => {
      // Clean up any previous run
      abortControllerRef.current?.abort();
      unsubscribeRef.current?.();

      const rootId = crypto.randomUUID();
      const ac = new AbortController();
      abortControllerRef.current = ac;

      setEvents([]);
      setStatus('running');
      setRootInvocationId(rootId);

      // Subscribe to the bus BEFORE calling orchestrator so no events are missed
      const unsub = eventBus.subscribe(rootId, (event) => {
        setEvents((prev) => [...prev, event]);
      });
      unsubscribeRef.current = unsub;

      try {
        const result = await orchestrator.run({
          agent,
          userPrompt: prompt,
          history,
          signal: ac.signal,
          // Pass rootId as override so orchestrator mints rootInvocationId = rootId,
          // which aligns with our bus subscription key set up above.
          rootInvocationIdOverride: rootId,
        });

        setStatus('done');
        return result;
      } catch (err) {
        if (ac.signal.aborted) {
          setStatus('idle');
        } else {
          setStatus('error');
        }
        throw err;
      } finally {
        unsubscribeRef.current?.();
        unsubscribeRef.current = null;
      }
    },
    [orchestrator, eventBus],
  );

  return { events, status, rootInvocationId, run, abort };
}
