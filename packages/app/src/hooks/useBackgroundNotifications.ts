/**
 * useBackgroundNotifications — surfaces background-delegation completions in
 * the live chat transcript.
 *
 * The delegation tool persists the notification message row and emits
 * `delegate:background-complete` on the AgentEventBus (possibly long after
 * the turn that spawned the run has ended). This hook listens on the bus and
 * appends the already-persisted row to React state so the user sees it
 * without reloading the conversation.
 *
 * Stream safety: if the conversation is busy (streaming / agent run / room
 * turn in flight) when a completion lands, the notification is queued and
 * flushed after the current turn finishes — appending mid-stream would
 * reorder the transcript around the message being streamed.
 *
 * In-process only: background runs (and therefore their notifications) die
 * with the process — accepted, per the locked "Daemon mode: NO" decision.
 */

import { useEffect, useRef } from 'react';
import type { Message } from '@uplnk/db';
import type { AgentEventBus } from '../lib/agents/eventBus.js';

export function useBackgroundNotifications(deps: {
  eventBus: AgentEventBus;
  conversationId: string;
  /** True while a stream / agent run / room turn is in flight. */
  busy: boolean;
  /** Append an already-persisted message row to the live message list. */
  onNotify: (msg: Message) => void;
}): void {
  const { eventBus, conversationId, busy, onNotify } = deps;

  // Refs keep the bus subscription stable across renders — the handler always
  // reads the latest busy flag and callback without resubscribing.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const onNotifyRef = useRef(onNotify);
  onNotifyRef.current = onNotify;
  const pendingRef = useRef<Message[]>([]);

  useEffect(() => {
    return eventBus.subscribeAll((ev) => {
      if (ev.type !== 'delegate:background-complete') return;
      // Only surface notifications persisted into THIS conversation. A null
      // messageId means persistence was unavailable — nothing to render.
      if (ev.conversationId !== conversationId || ev.messageId === null) return;

      const msg: Message = {
        id: ev.messageId,
        conversationId,
        role: 'assistant',
        content: ev.notification,
        toolCalls: null,
        toolCallId: null,
        inputTokens: null,
        outputTokens: null,
        timeToFirstToken: null,
        senderAgentName: ev.childAgent,
        addresseeAgentName: null,
        agentRunId: ev.childInvocationId,
        turnId: null,
        createdAt: new Date(ev.ts).toISOString(),
      };

      if (busyRef.current) {
        pendingRef.current.push(msg);
      } else {
        onNotifyRef.current(msg);
      }
    });
  }, [eventBus, conversationId]);

  // Flush queued notifications once the current turn has finished.
  useEffect(() => {
    if (busy || pendingRef.current.length === 0) return;
    const queued = pendingRef.current.splice(0);
    for (const msg of queued) {
      onNotifyRef.current(msg);
    }
  }, [busy]);
}
