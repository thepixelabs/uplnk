/**
 * useRoomRun — React hook for running a multi-agent room turn.
 *
 * Instantiates a RoomConductor for the lifetime of a conversation, subscribes
 * to the event bus so the transcript can render room-level + agent events in
 * real time, and exposes start()/abort() to ChatScreen.
 *
 * The conductor itself owns DB writes; this hook is purely the React-facing
 * orchestration glue.
 */

import { useCallback, useRef, useState } from 'react';
import type { CoreMessage } from 'ai';
import type { AgentEvent, AgentName } from '../lib/agents/types.js';
import type { AgentOrchestrator } from '../lib/agents/orchestrator.js';
import type { AgentEventBus } from '../lib/agents/eventBus.js';
import {
  RoomConductor,
  type RoomRunResult,
  type RoomBudget,
} from '../lib/agents/roomConductor.js';
import type { EphemeralRegistry } from '../lib/agents/ephemeralRegistry.js';

export type RoomRunStatus = 'idle' | 'running' | 'done' | 'error';

export interface UseRoomRunResult {
  events: AgentEvent[];
  status: RoomRunStatus;
  /** Stable id used to subscribe to the current turn's events. */
  currentTurnRoot: string;
  start: (args: {
    addressees: AgentName[];
    cc: AgentName[];
    userText: string;
    history: CoreMessage[];
  }) => Promise<RoomRunResult>;
  abort: () => void;
}

export interface UseRoomRunDeps {
  orchestrator: AgentOrchestrator;
  eventBus: AgentEventBus;
  registry: EphemeralRegistry;
  conversationId: string;
  /** Effective tool names in this chat — for spawn validation. */
  effectiveToolNames: ReadonlySet<string>;
  /** Optional budget override. */
  budget?: Partial<RoomBudget>;
}

export function useRoomRun(deps: UseRoomRunDeps): UseRoomRunResult {
  const { orchestrator, eventBus, registry, conversationId, effectiveToolNames, budget } = deps;

  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [status, setStatus] = useState<RoomRunStatus>('idle');
  const [currentTurnRoot, setCurrentTurnRoot] = useState('');

  const conductorRef = useRef<RoomConductor | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  const abort = useCallback(() => {
    conductorRef.current?.abort();
    abortRef.current?.abort();
    unsubRef.current?.();
    unsubRef.current = null;
    setStatus('idle');
  }, []);

  const start = useCallback(
    async (args: {
      addressees: AgentName[];
      cc: AgentName[];
      userText: string;
      history: CoreMessage[];
    }): Promise<RoomRunResult> => {
      abortRef.current?.abort();
      unsubRef.current?.();

      const ac = new AbortController();
      abortRef.current = ac;

      setEvents([]);
      setStatus('running');

      // Every start() creates a fresh conductor — budgets reset per user turn.
      // ephemeralSpawnsInConversation persists across conductors via DB.
      const conductor = new RoomConductor({
        orchestrator,
        registry,
        eventBus,
        conversationId,
        callerEffectiveToolNames: effectiveToolNames,
        abortSignal: ac.signal,
        ...(budget !== undefined ? { budget } : {}),
      });
      conductorRef.current = conductor;

      // Room events are emitted with a synthetic root id derived from the
      // conductor's turn. Since we don't know the id until conductor.start()
      // runs, subscribe via the wildcard channel and filter by __room__ events
      // OR any event that lands for a root we haven't seen before.
      const unsub = eventBus.subscribeAll((ev) => {
        setEvents((prev) => [...prev, ev]);
        if (ev.type === 'room:turn-start') {
          setCurrentTurnRoot(ev.rootInvocationId);
        }
      });
      unsubRef.current = unsub;

      try {
        const result = await conductor.start(args);
        setStatus(result.reason === 'error' ? 'error' : 'done');
        return result;
      } catch (err) {
        setStatus('error');
        throw err;
      } finally {
        unsubRef.current?.();
        unsubRef.current = null;
      }
    },
    [orchestrator, eventBus, registry, conversationId, effectiveToolNames, budget],
  );

  return { events, status, currentTurnRoot, start, abort };
}
