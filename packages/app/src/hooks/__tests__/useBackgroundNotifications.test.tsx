// @vitest-environment jsdom
/**
 * useBackgroundNotifications — surfacing of delegate:background-complete
 * events in the live message list.
 *
 * Contract under test:
 *   - a completion for THIS conversation with a persisted messageId is
 *     appended via onNotify when the screen is idle
 *   - completions landing while busy (stream / agent run in flight) are
 *     queued and flushed only after busy flips false — never mid-stream
 *   - other conversations, null messageIds, and unrelated event types are
 *     ignored
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Message } from '@uplnk/db';
import { AgentEventBus } from '../../lib/agents/eventBus.js';
import type { AgentEvent } from '../../lib/agents/types.js';
import { useBackgroundNotifications } from '../useBackgroundNotifications.js';

function makeCompletionEvent(overrides: Partial<Extract<AgentEvent, { type: 'delegate:background-complete' }>> = {}): AgentEvent {
  return {
    type: 'delegate:background-complete',
    invocationId: 'parent-inv',
    rootInvocationId: 'root-inv',
    parentInvocationId: null,
    agentName: 'parent-agent',
    depth: 1,
    seq: 0,
    ts: 1750000000000,
    childInvocationId: 'child-run-1',
    childAgent: 'coder',
    status: 'completed',
    summary: 'all done',
    notification: '[coder finished] all done',
    conversationId: 'conv-1',
    messageId: 'msg-1',
    ...overrides,
  };
}

function setup(initialBusy = false) {
  const eventBus = new AgentEventBus();
  const onNotify = vi.fn<(msg: Message) => void>();
  const view = renderHook(
    ({ busy }: { busy: boolean }) =>
      useBackgroundNotifications({
        eventBus,
        conversationId: 'conv-1',
        busy,
        onNotify,
      }),
    { initialProps: { busy: initialBusy } },
  );
  return { eventBus, onNotify, view };
}

describe('useBackgroundNotifications', () => {
  it('appends the persisted notification immediately when idle', () => {
    const { eventBus, onNotify } = setup(false);

    act(() => {
      eventBus.emitEvent(makeCompletionEvent());
    });

    expect(onNotify).toHaveBeenCalledTimes(1);
    const msg = onNotify.mock.calls[0]![0];
    expect(msg.id).toBe('msg-1');
    expect(msg.conversationId).toBe('conv-1');
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('[coder finished] all done');
    expect(msg.senderAgentName).toBe('coder');
    expect(msg.agentRunId).toBe('child-run-1');
  });

  it('queues while busy and flushes after the turn ends', () => {
    const { eventBus, onNotify, view } = setup(true);

    act(() => {
      eventBus.emitEvent(makeCompletionEvent());
      eventBus.emitEvent(makeCompletionEvent({ messageId: 'msg-2', childInvocationId: 'child-run-2' }));
    });
    // Still streaming — nothing appended yet
    expect(onNotify).not.toHaveBeenCalled();

    act(() => {
      view.rerender({ busy: false });
    });
    expect(onNotify).toHaveBeenCalledTimes(2);
    expect(onNotify.mock.calls.map((c) => c[0].id)).toEqual(['msg-1', 'msg-2']);
  });

  it('ignores completions for other conversations', () => {
    const { eventBus, onNotify } = setup(false);

    act(() => {
      eventBus.emitEvent(makeCompletionEvent({ conversationId: 'conv-OTHER' }));
    });

    expect(onNotify).not.toHaveBeenCalled();
  });

  it('ignores completions without a persisted messageId', () => {
    const { eventBus, onNotify } = setup(false);

    act(() => {
      eventBus.emitEvent(makeCompletionEvent({ messageId: null }));
    });

    expect(onNotify).not.toHaveBeenCalled();
  });

  it('ignores unrelated event types', () => {
    const { eventBus, onNotify } = setup(false);

    act(() => {
      eventBus.emitEvent({
        type: 'agent:end',
        invocationId: 'x',
        rootInvocationId: 'r',
        parentInvocationId: null,
        agentName: 'coder',
        depth: 1,
        seq: 0,
        ts: Date.now(),
        finalText: 'done',
        usage: { inputTokens: 0, outputTokens: 0 },
        durationMs: 1,
      });
    });

    expect(onNotify).not.toHaveBeenCalled();
  });
});
