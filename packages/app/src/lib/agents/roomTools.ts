/**
 * roomTools — per-invocation visible-handoff tools injected by RoomConductor.
 *
 * Three tools are produced:
 *   - handoff_to_agent({ to, message })   visible floor-pass (ends turn)
 *   - spawn_agent({ name, systemPrompt, … })  creates ephemeral + hands off
 *   - return_to_user()                    explicit "I'm done" signal
 *
 * Each tool writes to a shared `RoomSignal` that the conductor reads after
 * the agent's stream finishes. Tools do NOT directly mutate persistence —
 * the conductor owns all DB writes so ordering/audit stays single-threaded.
 */

import { tool } from 'ai';
import type { Tool } from 'ai';
import { z } from 'zod';
import type {
  AgentName,
  EphemeralAgentSpec,
  IAgentRegistry,
} from './types.js';

export interface RoomSignal {
  /** When non-null: this invocation issued a handoff; conductor takes over. */
  handoff: { to: AgentName; message: string } | null;
  /** When non-null: conductor should ensure this ephemeral exists before handoff. */
  spawn: EphemeralAgentSpec | null;
  /** True when the agent called return_to_user. */
  returnToUser: boolean;
}

export function newRoomSignal(): RoomSignal {
  return { handoff: null, spawn: null, returnToUser: false };
}

export interface RoomToolDeps {
  signal: RoomSignal;
  /** Calling agent's name — for cycle / self-handoff rejection. */
  selfName: AgentName;
  /** Registry used to validate handoff targets. Includes ephemerals. */
  registry: IAgentRegistry;
  /** Effective tools available to the caller — spawn cannot escalate beyond these. */
  callerEffectiveToolNames: ReadonlySet<string>;
  /**
   * Quota state passed in by the conductor so counts persist across every
   * invocation in the current user turn without tools needing their own store.
   */
  spawnsThisTurn: { count: number; max: number };
  spawnsThisConversation: { count: number; max: number };
}

const SPAWN_NAME_RE = /^[a-z][a-z0-9-]{2,31}$/;
const MAX_SYSTEM_PROMPT_BYTES = 4096;

export function buildRoomTools(deps: RoomToolDeps): Record<string, Tool> {
  const {
    signal,
    selfName,
    registry,
    callerEffectiveToolNames,
    spawnsThisTurn,
    spawnsThisConversation,
  } = deps;

  return {
    handoff_to_agent: tool({
      description:
        'Pass the floor to another agent in front of the user. Your turn ends ' +
        'immediately; the other agent receives your message and the full ' +
        'transcript. Use for real collaboration in the visible conversation. ' +
        'For quick private lookups, prefer ask_agent instead.',
      parameters: z.object({
        to: z.string().describe('Target agent name (kebab-case).'),
        message: z
          .string()
          .describe(
            'Message addressed to the other agent. Will appear in the transcript.',
          ),
      }),
      execute: async ({ to, message }) => {
        if (to === selfName) {
          throw new Error('handoff_to_agent: cannot hand off to yourself.');
        }
        if (registry.get(to) === undefined) {
          throw new Error(`handoff_to_agent: no such agent @${to}.`);
        }
        signal.handoff = { to, message };
        // Intentionally return a short confirmation. The AI SDK will feed this
        // string back to the model as the tool result, but the conductor
        // short-circuits the agent's run immediately after this tool call by
        // abort-signalling mid-stream (see RoomConductor) — so in practice the
        // model rarely sees this string.
        return `[floor passed to @${to}]`;
      },
    }),

    spawn_agent: tool({
      description:
        'Create a brand-new ephemeral agent scoped to this conversation and ' +
        'immediately hand the floor to it. Use for ad-hoc specialists ' +
        '("spawn a code-reviewer for this file"). The spawned agent cannot ' +
        'access tools you do not already have.',
      parameters: z.object({
        name: z.string().describe('Unique kebab-case name (3-32 chars).'),
        systemPrompt: z.string().describe('The new agent\'s system prompt.'),
        firstMessage: z
          .string()
          .describe('First message the new agent sees when it takes the floor.'),
        tools: z
          .array(z.string())
          .optional()
          .describe('Subset of caller\'s tools to grant. Defaults to none.'),
        model: z
          .string()
          .optional()
          .describe("Model id or 'inherit' (default). Only use for known models."),
        maxTurns: z.number().int().min(1).max(10).optional(),
        maxDepth: z.number().int().min(1).max(5).optional(),
      }),
      execute: async (args) => {
        if (!SPAWN_NAME_RE.test(args.name)) {
          throw new Error(
            'spawn_agent: name must be kebab-case, 3–32 chars, starting with a letter.',
          );
        }
        if (Buffer.byteLength(args.systemPrompt, 'utf8') > MAX_SYSTEM_PROMPT_BYTES) {
          throw new Error(
            `spawn_agent: systemPrompt exceeds ${MAX_SYSTEM_PROMPT_BYTES} bytes.`,
          );
        }
        if (spawnsThisTurn.count >= spawnsThisTurn.max) {
          throw new Error(
            `spawn_agent: turn quota reached (${spawnsThisTurn.max}).`,
          );
        }
        if (spawnsThisConversation.count >= spawnsThisConversation.max) {
          throw new Error(
            `spawn_agent: conversation quota reached (${spawnsThisConversation.max}).`,
          );
        }
        if (registry.get(args.name) !== undefined) {
          throw new Error(
            `spawn_agent: @${args.name} already exists in the registry.`,
          );
        }
        if (args.tools) {
          for (const t of args.tools) {
            if (!callerEffectiveToolNames.has(t)) {
              throw new Error(
                `spawn_agent: tool "${t}" is not in caller's tool set — cannot escalate.`,
              );
            }
          }
        }

        const spec: EphemeralAgentSpec = {
          name: args.name,
          systemPrompt: args.systemPrompt,
          firstMessage: args.firstMessage,
          ...(args.tools !== undefined ? { tools: args.tools } : {}),
          ...(args.model !== undefined ? { model: args.model } : {}),
          ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
          ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
        };
        signal.spawn = spec;
        signal.handoff = { to: args.name, message: args.firstMessage };
        return `[spawned @${args.name}, floor passed to them]`;
      },
    }),

    return_to_user: tool({
      description:
        'Explicitly end the multi-agent turn and return control to the user. ' +
        'Call this when the conversation is ready for another user message ' +
        'and no further agent should take a turn.',
      parameters: z.object({}),
      execute: async () => {
        signal.returnToUser = true;
        return '[turn returned to user]';
      },
    }),
  };
}
