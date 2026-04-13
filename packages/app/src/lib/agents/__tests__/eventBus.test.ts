/**
 * eventBus.ts — unit tests for AgentEventBus
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentEventBus } from '../eventBus.js';
import type { AgentEvent } from '../types.js';

function makeEvent(rootInvocationId: string): AgentEvent {
  return {
    type: 'agent:start',
    invocationId: 'inv-1',
    rootInvocationId,
    parentInvocationId: null,
    agentName: 'test-agent',
    depth: 1,
    seq: 0,
    ts: Date.now(),
    userPrompt: 'hello',
    model: 'inherit',
  };
}

describe('AgentEventBus', () => {
  it('delivers events to rootInvocationId subscribers', () => {
    const bus = new AgentEventBus();
    const received: AgentEvent[] = [];
    bus.subscribe('root-1', (e) => received.push(e));

    const event = makeEvent('root-1');
    bus.emitEvent(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
  });

  it('does not deliver events to non-matching subscribers', () => {
    const bus = new AgentEventBus();
    const received: AgentEvent[] = [];
    bus.subscribe('root-2', (e) => received.push(e));

    bus.emitEvent(makeEvent('root-1'));

    expect(received).toHaveLength(0);
  });

  it('delivers to wildcard subscribeAll', () => {
    const bus = new AgentEventBus();
    const received: AgentEvent[] = [];
    bus.subscribeAll((e) => received.push(e));

    bus.emitEvent(makeEvent('root-1'));
    bus.emitEvent(makeEvent('root-2'));

    expect(received).toHaveLength(2);
  });

  it('unsubscribe stops delivery', () => {
    const bus = new AgentEventBus();
    const received: AgentEvent[] = [];
    const unsub = bus.subscribe('root-1', (e) => received.push(e));

    bus.emitEvent(makeEvent('root-1'));
    unsub();
    bus.emitEvent(makeEvent('root-1'));

    expect(received).toHaveLength(1);
  });

  it('multiple subscribers on the same root all receive events', () => {
    const bus = new AgentEventBus();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    bus.subscribe('root-1', cb1);
    bus.subscribe('root-1', cb2);

    bus.emitEvent(makeEvent('root-1'));

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('emits on both rootInvocationId channel and wildcard', () => {
    const bus = new AgentEventBus();
    const rootCb = vi.fn();
    const allCb = vi.fn();
    bus.subscribe('root-1', rootCb);
    bus.subscribeAll(allCb);

    bus.emitEvent(makeEvent('root-1'));

    expect(rootCb).toHaveBeenCalledTimes(1);
    expect(allCb).toHaveBeenCalledTimes(1);
  });
});
