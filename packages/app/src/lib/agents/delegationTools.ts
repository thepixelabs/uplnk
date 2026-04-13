/**
 * buildDelegationTools — constructs per-invocation delegation + state tools.
 *
 * Four tools are produced, each closing over a DelegationContext:
 *   - delegate_to_agent  (full handoff — model should stop after returning)
 *   - ask_agent          (call-and-return — model continues after result)
 *   - state_get          (read shared state)
 *   - state_set          (write shared state)
 *
 * Only the string summary is returned to the parent LLM — the child's full
 * transcript never leaks into the parent's context window.
 */

import { tool } from 'ai';
import type { Tool } from 'ai';
import { z } from 'zod';
import type { DelegationContext } from './types.js';

const GLOBAL_MAX_DEPTH = 5;

function enforceDepth(ctx: DelegationContext, targetAgent: string): void {
  if (ctx.self.depth >= GLOBAL_MAX_DEPTH) {
    throw new Error(
      `Delegation depth limit (${GLOBAL_MAX_DEPTH}) reached. Cannot delegate to @${targetAgent}.`,
    );
  }
  if (ctx.self.depth > ctx.self.agent.maxDepth) {
    throw new Error(
      `Agent @${ctx.self.agent.name} has maxDepth=${ctx.self.agent.maxDepth} and is already at depth ${ctx.self.depth}. Cannot delegate to @${targetAgent}.`,
    );
  }
}

function enforceNoLoop(ctx: DelegationContext, targetAgent: string): void {
  if (ctx.ancestry.includes(targetAgent)) {
    throw new Error(
      `Cycle detected: @${targetAgent} is already in the delegation chain [${ctx.ancestry.join(' → ')}].`,
    );
  }
}

function resolveAllowedAgents(ctx: DelegationContext): string[] {
  const { agents } = ctx.self.agent;
  if (!agents || agents.length === 0) return [];

  const allNames = ctx.registry.list().map((a) => a.name);
  const allowed = agents[0] === '*' ? allNames : agents;

  // Remove ancestors to prevent cycles
  return allowed.filter((n) => !ctx.ancestry.includes(n));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildDelegationTools(ctx: DelegationContext, emit: (event: import('./types.js').AgentEvent) => void): Record<string, Tool<any, any>> {
  const allowedAgents = resolveAllowedAgents(ctx);

  // If no delegation is possible, return only state tools
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, Tool<any, any>> = {};

  if (allowedAgents.length > 0) {
    const agentEnum = z.enum(allowedAgents as [string, ...string[]]);

    // ── delegate_to_agent ───────────────────────────────────────────────────
    tools['delegate_to_agent'] = tool({
      description: `Hand off the current task to a specialist agent. Control transfers — you should wrap up after the delegate returns. Allowed targets: ${allowedAgents.join(', ')}`,
      parameters: z.object({
        agent: agentEnum.describe('Name of the agent to delegate to.'),
        prompt: z.string().describe('Task description for the delegate. Be specific.'),
      }),
      execute: async ({ agent: agentName, prompt }) => {
        enforceDepth(ctx, agentName);
        enforceNoLoop(ctx, agentName);

        const agentDef = ctx.registry.get(agentName);
        if (agentDef === undefined) {
          throw new Error(`Agent @${agentName} not found in registry.`);
        }

        const result = await ctx.orchestrator.run({
          agent: agentDef,
          userPrompt: prompt,
          parent: {
            invocationId: ctx.self.invocationId,
            depth: ctx.self.depth,
            ancestry: ctx.ancestry,
            rootInvocationId: ctx.rootInvocationId,
            state: ctx.state,
            nextSeq: ctx.nextSeq,
            inheritedModel: ctx.inheritedModel,
            inheritedTools: ctx.inheritedTools,
          },
          signal: ctx.signal,
        });

        emit({
          type: 'delegate:spawn',
          invocationId: ctx.self.invocationId,
          rootInvocationId: ctx.rootInvocationId,
          parentInvocationId: ctx.self.invocationId,
          agentName: ctx.self.agent.name,
          depth: ctx.self.depth,
          seq: ctx.nextSeq(),
          ts: Date.now(),
          childInvocationId: result.invocationId,
          childAgent: agentName,
          mode: 'delegate',
          prompt,
        });

        emit({
          type: 'delegate:return',
          invocationId: ctx.self.invocationId,
          rootInvocationId: ctx.rootInvocationId,
          parentInvocationId: ctx.self.invocationId,
          agentName: ctx.self.agent.name,
          depth: ctx.self.depth,
          seq: ctx.nextSeq(),
          ts: Date.now(),
          childInvocationId: result.invocationId,
          childAgent: agentName,
          mode: 'delegate',
          summary: result.finalText,
        });

        // Only the summary goes back to the parent LLM
        return result.finalText;
      },
    });

    // ── ask_agent ───────────────────────────────────────────────────────────
    tools['ask_agent'] = tool({
      description: `Call a specialist agent and return here with the result. You keep control and can continue after receiving the answer. Allowed targets: ${allowedAgents.join(', ')}`,
      parameters: z.object({
        agent: agentEnum.describe('Name of the agent to ask.'),
        prompt: z.string().describe('Question or task for the agent. Be specific.'),
      }),
      execute: async ({ agent: agentName, prompt }) => {
        enforceDepth(ctx, agentName);
        enforceNoLoop(ctx, agentName);

        const agentDef = ctx.registry.get(agentName);
        if (agentDef === undefined) {
          throw new Error(`Agent @${agentName} not found in registry.`);
        }

        const result = await ctx.orchestrator.run({
          agent: agentDef,
          userPrompt: prompt,
          parent: {
            invocationId: ctx.self.invocationId,
            depth: ctx.self.depth,
            ancestry: ctx.ancestry,
            rootInvocationId: ctx.rootInvocationId,
            state: ctx.state,
            nextSeq: ctx.nextSeq,
            inheritedModel: ctx.inheritedModel,
            inheritedTools: ctx.inheritedTools,
          },
          signal: ctx.signal,
        });

        emit({
          type: 'delegate:spawn',
          invocationId: ctx.self.invocationId,
          rootInvocationId: ctx.rootInvocationId,
          parentInvocationId: ctx.self.invocationId,
          agentName: ctx.self.agent.name,
          depth: ctx.self.depth,
          seq: ctx.nextSeq(),
          ts: Date.now(),
          childInvocationId: result.invocationId,
          childAgent: agentName,
          mode: 'ask',
          prompt,
        });

        emit({
          type: 'delegate:return',
          invocationId: ctx.self.invocationId,
          rootInvocationId: ctx.rootInvocationId,
          parentInvocationId: ctx.self.invocationId,
          agentName: ctx.self.agent.name,
          depth: ctx.self.depth,
          seq: ctx.nextSeq(),
          ts: Date.now(),
          childInvocationId: result.invocationId,
          childAgent: agentName,
          mode: 'ask',
          summary: result.finalText,
        });

        return result.finalText;
      },
    });
  }

  // ── state_get ─────────────────────────────────────────────────────────────
  tools['state_get'] = tool({
    description: 'Read a value from the shared delegation state. Useful for reading results written by another agent.',
    parameters: z.object({
      key: z.string().describe('State key to read.'),
    }),
    execute: async ({ key }) => {
      emit({
        type: 'state:get',
        invocationId: ctx.self.invocationId,
        rootInvocationId: ctx.rootInvocationId,
        parentInvocationId: ctx.self.parentInvocationId,
        agentName: ctx.self.agent.name,
        depth: ctx.self.depth,
        seq: ctx.nextSeq(),
        ts: Date.now(),
        key,
      });
      return { value: ctx.state[key] ?? null };
    },
  });

  // ── state_set ─────────────────────────────────────────────────────────────
  tools['state_set'] = tool({
    description: 'Write a value to the shared delegation state so other agents can read it.',
    parameters: z.object({
      key: z.string().describe('State key to write.'),
      value: z.unknown().describe('Value to store.'),
    }),
    execute: async ({ key, value }) => {
      ctx.state[key] = value;
      emit({
        type: 'state:set',
        invocationId: ctx.self.invocationId,
        rootInvocationId: ctx.rootInvocationId,
        parentInvocationId: ctx.self.parentInvocationId,
        agentName: ctx.self.agent.name,
        depth: ctx.self.depth,
        seq: ctx.nextSeq(),
        ts: Date.now(),
        key,
        value,
      });
      return { ok: true };
    },
  });

  return tools;
}
