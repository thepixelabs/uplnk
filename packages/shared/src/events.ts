export type UplnkEventKind =
  | 'stream.delta'
  | 'stream.done'
  | 'stream.error'
  | 'tool.call'
  | 'tool.result'
  | 'flow.step.start'
  | 'flow.step.done'
  | 'flow.step.error'
  | 'flow.run.start'
  | 'flow.run.done'
  | 'robotic.inject'
  | 'robotic.read'
  | 'robotic.turn'
  | 'robotic.goal.met'
  | 'error';

export interface StreamDeltaEvent {
  kind: 'stream.delta';
  runId: string;
  text: string;
}

export interface StreamDoneEvent {
  kind: 'stream.done';
  runId: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface StreamErrorEvent {
  kind: 'stream.error';
  runId: string;
  error: string;
}

export interface ToolCallEvent {
  kind: 'tool.call';
  runId: string;
  toolName: string;
  args: unknown;
}

export interface ToolResultEvent {
  kind: 'tool.result';
  runId: string;
  toolName: string;
  result: unknown;
}

export interface FlowStepStartEvent {
  kind: 'flow.step.start';
  runId: string;
  stepId: string;
  stepIndex: number;
}

export interface FlowStepDoneEvent {
  kind: 'flow.step.done';
  runId: string;
  stepId: string;
  output: unknown;
}

export interface FlowStepErrorEvent {
  kind: 'flow.step.error';
  runId: string;
  stepId: string;
  error: string;
}

export interface FlowRunStartEvent {
  kind: 'flow.run.start';
  runId: string;
  flowName: string;
}

export interface FlowRunDoneEvent {
  kind: 'flow.run.done';
  runId: string;
  status: 'succeeded' | 'failed' | 'cancelled';
}

export interface RoboticInjectEvent {
  kind: 'robotic.inject';
  sessionId: string;
  text: string;
  turn: number;
}

export interface RoboticReadEvent {
  kind: 'robotic.read';
  sessionId: string;
  text: string;
  turn: number;
}

export interface RoboticTurnEvent {
  kind: 'robotic.turn';
  sessionId: string;
  turn: number;
  goalProgress: number;
}

export interface RoboticGoalMetEvent {
  kind: 'robotic.goal.met';
  sessionId: string;
  turns: number;
}

export interface ErrorEvent {
  kind: 'error';
  runId?: string;
  message: string;
  code?: string;
}

export type UplnkEvent =
  | StreamDeltaEvent
  | StreamDoneEvent
  | StreamErrorEvent
  | ToolCallEvent
  | ToolResultEvent
  | FlowStepStartEvent
  | FlowStepDoneEvent
  | FlowStepErrorEvent
  | FlowRunStartEvent
  | FlowRunDoneEvent
  | RoboticInjectEvent
  | RoboticReadEvent
  | RoboticTurnEvent
  | RoboticGoalMetEvent
  | ErrorEvent;

export type EventHandler = (event: UplnkEvent) => void;

export class EventBus {
  private handlers: EventHandler[] = [];

  subscribe(handler: EventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  emit(event: UplnkEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // swallow handler errors
      }
    }
  }
}
