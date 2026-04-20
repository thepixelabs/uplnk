/**
 * RoomConductor — strict-serial floor-passing across multiple agents within
 * a single user turn. Coordinates:
 *   - who goes next (addressee queue + handoff events)
 *   - budget caps (max handoffs / tokens / wall time per user turn)
 *   - ping-pong detection between two agents
 *   - DB persistence of visible messages + agent_runs rows
 *   - exactly-one `room:turn-end` event per user turn (even on error)
 *
 * The conductor is the ONLY author of `messages` rows during a room turn —
 * room tools just flip flags on a shared RoomSignal, they never write the DB.
 */

import { ulid } from 'ulid';
import type { CoreMessage } from 'ai';
import {
  db as globalDb,
  insertMessage,
  agentRuns,
  type Db,
} from '@uplnk/db';
import { eq } from 'drizzle-orm';
import type {
  AgentDef,
  AgentEvent,
  AgentName,
  EphemeralAgentSpec,
  IAgentOrchestrator,
  InvocationId,
} from './types.js';
import type { AgentEventBus } from './eventBus.js';
import { buildRoomTools, newRoomSignal, type RoomSignal } from './roomTools.js';
import type { EphemeralRegistry } from './ephemeralRegistry.js';

export interface RoomBudget {
  maxHandoffsPerUserTurn: number;
  maxTokensPerUserTurn: number;
  maxWallMsPerUserTurn: number;
  maxEphemeralSpawnsPerTurn: number;
  maxEphemeralSpawnsPerConversation: number;
}

export const DEFAULT_ROOM_BUDGET: RoomBudget = {
  maxHandoffsPerUserTurn: 8,
  maxTokensPerUserTurn: 60_000,
  maxWallMsPerUserTurn: 120_000,
  maxEphemeralSpawnsPerTurn: 3,
  maxEphemeralSpawnsPerConversation: 10,
};

export interface RoomStartInput {
  addressees: AgentName[];
  cc: AgentName[];
  userText: string;
  /** Pre-built prior-turn history (user/assistant/system messages). */
  history: CoreMessage[];
}

export interface RoomConductorDeps {
  orchestrator: IAgentOrchestrator;
  registry: EphemeralRegistry;
  eventBus: AgentEventBus;
  conversationId: string;
  budget?: Partial<RoomBudget>;
  /** Effective tool names available to agents in this conversation — for spawn validation. */
  callerEffectiveToolNames: ReadonlySet<string>;
  /** Signal that aborts every in-flight invocation (e.g. user Ctrl+C). */
  abortSignal?: AbortSignal;
  /** Injected DB handle for tests; defaults to global. */
  db?: Db;
  /** Persist agent_runs rows from bus events. Defaults to true. */
  persistAgentRuns?: boolean;
}

function normaliseTokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface RoomRunResult {
  turnId: string;
  reason: 'done' | 'budget' | 'ping-pong' | 'error' | 'aborted';
  handoffs: number;
  spawns: number;
  tokens: number;
}

export class RoomConductor {
  private readonly deps: RoomConductorDeps;
  private readonly budget: RoomBudget;
  private readonly db: Db;
  private readonly persistRuns: boolean;
  private aborted = false;
  private spawnsThisConversation = 0;

  constructor(deps: RoomConductorDeps) {
    this.deps = deps;
    this.budget = { ...DEFAULT_ROOM_BUDGET, ...(deps.budget ?? {}) };
    this.db = deps.db ?? globalDb;
    this.persistRuns = deps.persistAgentRuns ?? true;
  }

  /** Total ephemeral spawns across this conversation so far (best-effort). */
  get ephemeralSpawnsInConversation(): number {
    return this.spawnsThisConversation;
  }

  abort(): void {
    this.aborted = true;
  }

  async start(input: RoomStartInput): Promise<RoomRunResult> {
    const turnId = ulid();
    const rootInvocationId = ulid();
    const { addressees, cc, userText, history } = input;

    // Queue of pending invocations. First addressee holds the floor; handoffs
    // prepend. CC-only mentions don't auto-run — they're passed as context so
    // the addressee can pass the floor to them via handoff_to_agent.
    const queue: { agent: AgentDef; prompt: string; from: AgentName | null }[] = [];
    for (const name of addressees) {
      const agent = this.deps.registry.get(name);
      if (agent !== undefined) {
        queue.push({
          agent,
          prompt: buildAddresseePrompt(userText, name, cc),
          from: null,
        });
        break; // only the first addressee runs first; additional addressees
               // just go in as CC-like context
      }
    }
    if (queue.length === 0) {
      return { turnId, reason: 'error', handoffs: 0, spawns: 0, tokens: 0 };
    }

    const startTs = Date.now();
    let handoffs = 0;
    let spawns = 0;
    let totalTokens = 0;
    let reason: RoomRunResult['reason'] = 'done';

    // Ping-pong window: remember last 3 senders' token-sets.
    const recentSenders: { name: AgentName; tokens: Set<string> }[] = [];

    const spawnsThisTurn = { count: 0, max: this.budget.maxEphemeralSpawnsPerTurn };
    const spawnsInConv = {
      count: this.spawnsThisConversation,
      max: this.budget.maxEphemeralSpawnsPerConversation,
    };

    // Synthetic event-bus base for room-level events — emitted from a phantom
    // "room" invocation id so subscribers can differentiate. We reuse the same
    // root so the UI can group them with agent events.
    const roomInvocationId = `${rootInvocationId}-room`;
    let seq = 0;
    const nextSeq = () => seq++;
    const emitRoom = (ev: Omit<AgentEvent, 'invocationId' | 'rootInvocationId' | 'parentInvocationId' | 'agentName' | 'depth' | 'seq' | 'ts'> & { type: string }): void => {
      this.deps.eventBus.emitEvent({
        ...(ev as object),
        invocationId: roomInvocationId,
        rootInvocationId,
        parentInvocationId: null,
        agentName: '__room__',
        depth: 0,
        seq: nextSeq(),
        ts: Date.now(),
      } as AgentEvent);
    };

    emitRoom({
      type: 'room:turn-start',
      turnId,
      addressees,
      cc,
    } as unknown as Omit<AgentEvent, 'invocationId' | 'rootInvocationId' | 'parentInvocationId' | 'agentName' | 'depth' | 'seq' | 'ts'> & { type: string });

    // agent_runs persistence: subscribe to lifecycle events for this root.
    const unsubAgentRuns = this.persistRuns
      ? this.subscribeAgentRunsPersistence(rootInvocationId, this.deps.conversationId, turnId)
      : () => {};

    // Insert the user message row once — visible in the transcript, anchors the turn.
    try {
      insertMessage(this.db, {
        id: ulid(),
        conversationId: this.deps.conversationId,
        role: 'user',
        content: userText,
        turnId,
      });
    } catch {
      // Row insertion is non-fatal — the conversation may already carry it.
    }

    try {
      let prevSender: AgentName | null = null;
      while (queue.length > 0) {
        if (this.aborted || this.deps.abortSignal?.aborted) {
          reason = 'aborted';
          break;
        }
        const wall = Date.now() - startTs;
        if (wall >= this.budget.maxWallMsPerUserTurn) {
          reason = 'budget';
          emitRoom({
            type: 'room:budget-warn',
            turnId,
            reason: 'wall-clock',
            usage: { handoffs, tokens: totalTokens, wallMs: wall },
          } as unknown as Omit<AgentEvent, 'invocationId' | 'rootInvocationId' | 'parentInvocationId' | 'agentName' | 'depth' | 'seq' | 'ts'> & { type: string });
          break;
        }
        if (totalTokens >= this.budget.maxTokensPerUserTurn) {
          reason = 'budget';
          emitRoom({
            type: 'room:budget-warn',
            turnId,
            reason: 'tokens',
            usage: { handoffs, tokens: totalTokens, wallMs: wall },
          } as unknown as Omit<AgentEvent, 'invocationId' | 'rootInvocationId' | 'parentInvocationId' | 'agentName' | 'depth' | 'seq' | 'ts'> & { type: string });
          break;
        }
        if (handoffs >= this.budget.maxHandoffsPerUserTurn) {
          reason = 'budget';
          emitRoom({
            type: 'room:budget-warn',
            turnId,
            reason: 'handoffs',
            usage: { handoffs, tokens: totalTokens, wallMs: wall },
          } as unknown as Omit<AgentEvent, 'invocationId' | 'rootInvocationId' | 'parentInvocationId' | 'agentName' | 'depth' | 'seq' | 'ts'> & { type: string });
          break;
        }

        const next = queue.shift()!;
        const roomSignal: RoomSignal = newRoomSignal();
        const roomTools = buildRoomTools({
          signal: roomSignal,
          selfName: next.agent.name,
          registry: this.deps.registry,
          callerEffectiveToolNames: this.deps.callerEffectiveToolNames,
          spawnsThisTurn,
          spawnsThisConversation: spawnsInConv,
        });

        const invokeSignal = this.deps.abortSignal ?? new AbortController().signal;

        let result;
        try {
          result = await this.deps.orchestrator.run({
            agent: next.agent,
            userPrompt: next.prompt,
            history,
            rootInvocationIdOverride: rootInvocationId,
            signal: invokeSignal,
            extraTools: roomTools,
          });
        } catch (err) {
          reason = 'error';
          emitRoom({
            type: 'room:budget-warn',
            turnId,
            reason: `agent-error: ${(err as Error).message.slice(0, 80)}`,
            usage: { handoffs, tokens: totalTokens, wallMs: Date.now() - startTs },
          } as unknown as Omit<AgentEvent, 'invocationId' | 'rootInvocationId' | 'parentInvocationId' | 'agentName' | 'depth' | 'seq' | 'ts'> & { type: string });
          break;
        }
        totalTokens += result.usage.inputTokens + result.usage.outputTokens;

        // Persist the agent's visible message.
        const agentMsgId = ulid();
        try {
          insertMessage(this.db, {
            id: agentMsgId,
            conversationId: this.deps.conversationId,
            role: 'assistant',
            content: result.finalText,
            senderAgentName: next.agent.name,
            ...(roomSignal.handoff
              ? { addresseeAgentName: roomSignal.handoff.to }
              : {}),
            agentRunId: result.invocationId,
            turnId,
          });
        } catch {
          // Non-fatal: the DB may have evolved mid-turn; UI already saw events.
        }

        // Ping-pong check on the last three messages.
        const tokens = normaliseTokenSet(result.finalText);
        recentSenders.push({ name: next.agent.name, tokens });
        if (recentSenders.length > 3) recentSenders.shift();
        if (
          recentSenders.length === 3 &&
          recentSenders[0]!.name === recentSenders[2]!.name &&
          recentSenders[0]!.name !== recentSenders[1]!.name &&
          jaccard(recentSenders[0]!.tokens, recentSenders[2]!.tokens) >= 0.6
        ) {
          reason = 'ping-pong';
          emitRoom({
            type: 'room:ping-pong',
            turnId,
            between: [recentSenders[0]!.name, recentSenders[1]!.name],
          } as unknown as Omit<AgentEvent, 'invocationId' | 'rootInvocationId' | 'parentInvocationId' | 'agentName' | 'depth' | 'seq' | 'ts'> & { type: string });
          break;
        }

        // If spawn signalled, create the ephemeral and swap the queued target.
        if (roomSignal.spawn !== null) {
          let newAgent: AgentDef;
          try {
            newAgent = this.deps.registry.create(roomSignal.spawn as EphemeralAgentSpec);
          } catch (err) {
            // Couldn't spawn — treat as handoff failure; return to user.
            reason = 'error';
            emitRoom({
              type: 'room:budget-warn',
              turnId,
              reason: `spawn-failed: ${(err as Error).message.slice(0, 80)}`,
              usage: { handoffs, tokens: totalTokens, wallMs: Date.now() - startTs },
            } as unknown as Omit<AgentEvent, 'invocationId' | 'rootInvocationId' | 'parentInvocationId' | 'agentName' | 'depth' | 'seq' | 'ts'> & { type: string });
            break;
          }
          spawns++;
          spawnsThisTurn.count++;
          this.spawnsThisConversation++;
          spawnsInConv.count = this.spawnsThisConversation;
          emitRoom({
            type: 'room:spawn',
            turnId,
            spawnedName: newAgent.name,
            spawnedBy: next.agent.name,
          } as unknown as Omit<AgentEvent, 'invocationId' | 'rootInvocationId' | 'parentInvocationId' | 'agentName' | 'depth' | 'seq' | 'ts'> & { type: string });
        }

        if (roomSignal.returnToUser) {
          reason = 'done';
          break;
        }

        if (roomSignal.handoff !== null) {
          const target = this.deps.registry.get(roomSignal.handoff.to);
          if (target === undefined) {
            reason = 'error';
            break;
          }
          handoffs++;
          emitRoom({
            type: 'room:handoff',
            turnId,
            from: next.agent.name,
            to: target.name,
            message: roomSignal.handoff.message,
          } as unknown as Omit<AgentEvent, 'invocationId' | 'rootInvocationId' | 'parentInvocationId' | 'agentName' | 'depth' | 'seq' | 'ts'> & { type: string });
          queue.push({
            agent: target,
            prompt: buildHandoffPrompt(
              userText,
              prevSender,
              next.agent.name,
              target.name,
              roomSignal.handoff.message,
            ),
            from: next.agent.name,
          });
        } else {
          // Agent finished without handoff or return_to_user → end turn.
          reason = 'done';
        }
        prevSender = next.agent.name;
      }
    } finally {
      emitRoom({
        type: 'room:turn-end',
        turnId,
        reason,
        handoffs,
      } as unknown as Omit<AgentEvent, 'invocationId' | 'rootInvocationId' | 'parentInvocationId' | 'agentName' | 'depth' | 'seq' | 'ts'> & { type: string });
      unsubAgentRuns();
    }

    return { turnId, reason, handoffs, spawns, tokens: totalTokens };
  }

  /**
   * Persist agent_runs rows by observing lifecycle events on the bus for the
   * current root. INSERTs on agent:start; UPDATEs on agent:end/error/aborted.
   * Returns the unsubscribe function.
   */
  private subscribeAgentRunsPersistence(
    rootInvocationId: InvocationId,
    conversationId: string,
    _turnId: string,
  ): () => void {
    const cb = (ev: AgentEvent) => {
      if (ev.rootInvocationId !== rootInvocationId) return;
      if (ev.agentName === '__room__') return;
      try {
        if (ev.type === 'agent:start') {
          this.db
            .insert(agentRuns)
            .values({
              id: ev.invocationId,
              conversationId,
              rootInvocationId: ev.rootInvocationId,
              parentInvocationId: ev.parentInvocationId,
              agentName: ev.agentName,
              depth: ev.depth,
              ancestryJson: JSON.stringify([]),
              model: ev.model,
              status: 'running',
              startedAt: new Date(ev.ts).toISOString(),
            })
            .onConflictDoNothing()
            .run();
        } else if (ev.type === 'agent:end') {
          this.db
            .update(agentRuns)
            .set({
              status: 'completed',
              inputTokens: ev.usage.inputTokens,
              outputTokens: ev.usage.outputTokens,
              endedAt: new Date(ev.ts).toISOString(),
            })
            .where(eq(agentRuns.id, ev.invocationId))
            .run();
        } else if (ev.type === 'agent:error') {
          this.db
            .update(agentRuns)
            .set({
              status: 'errored',
              errorMessage: ev.error.message,
              endedAt: new Date(ev.ts).toISOString(),
            })
            .where(eq(agentRuns.id, ev.invocationId))
            .run();
        } else if (ev.type === 'agent:aborted') {
          this.db
            .update(agentRuns)
            .set({
              status: 'aborted',
              errorMessage: ev.reason,
              endedAt: new Date(ev.ts).toISOString(),
            })
            .where(eq(agentRuns.id, ev.invocationId))
            .run();
        }
      } catch {
        // DB persistence is best-effort: the event bus is the source of truth
        // for UI; losing a row here would only affect post-turn inspection.
      }
    };
    return this.deps.eventBus.subscribe(rootInvocationId, cb);
  }
}

function buildAddresseePrompt(
  userText: string,
  addressee: AgentName,
  cc: AgentName[],
): string {
  const ccNote =
    cc.length > 0
      ? `\n\n[The user CC'd: ${cc.map((n) => `@${n}`).join(', ')}. You may pass the floor to them via handoff_to_agent.]`
      : '';
  return `[to: @${addressee}] ${userText}${ccNote}`;
}

function buildHandoffPrompt(
  originalUserText: string,
  _priorSender: AgentName | null,
  fromAgent: AgentName,
  toAgent: AgentName,
  handoffMessage: string,
): string {
  return [
    `[handoff from @${fromAgent} to @${toAgent}]`,
    `Original user request: ${originalUserText}`,
    '',
    `@${fromAgent} says:`,
    handoffMessage,
    '',
    `You are @${toAgent}. Respond. If you want another agent to take over, call handoff_to_agent. If the conversation should return to the user, call return_to_user. Otherwise, just reply normally and your turn will end.`,
  ].join('\n');
}
