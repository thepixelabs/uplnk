/**
 * AgentEventBus — typed EventEmitter for agent lifecycle events.
 * All events in a delegation tree are emitted here, tagged with
 * rootInvocationId so subscribers can filter to their tree.
 */

import { EventEmitter } from 'node:events';
import type { AgentEvent, InvocationId } from './types.js';

export class AgentEventBus extends EventEmitter {
  /** Emit a typed agent event. Broadcasts on both the rootInvocationId channel
   *  and the wildcard '*' channel (useful for debugging/logging). */
  emitEvent(event: AgentEvent): void {
    this.emit(event.rootInvocationId, event);
    this.emit('*', event);
  }

  /**
   * Subscribe to all events for a given root invocation tree.
   * Returns an unsubscribe function.
   */
  subscribe(rootInvocationId: InvocationId, cb: (event: AgentEvent) => void): () => void {
    this.on(rootInvocationId, cb);
    return () => {
      this.off(rootInvocationId, cb);
    };
  }

  /**
   * Subscribe to ALL events across all invocations (useful for logging).
   */
  subscribeAll(cb: (event: AgentEvent) => void): () => void {
    this.on('*', cb);
    return () => {
      this.off('*', cb);
    };
  }
}

// Module-level singleton
let _globalBus: AgentEventBus | undefined;

export function getGlobalAgentEventBus(): AgentEventBus {
  if (_globalBus === undefined) {
    _globalBus = new AgentEventBus();
    // Prevent MaxListenersExceededWarning in deep delegation trees
    _globalBus.setMaxListeners(100);
  }
  return _globalBus;
}
