/**
 * Zod schema + defaults for agent frontmatter validation.
 * Used by AgentRegistry to validate .md files at load time.
 */

import { z } from 'zod';
import matter from 'gray-matter';
import type { AgentDef } from './types.js';

const AgentColorSchema = z.string(); // hex or named color

const AgentDefFrontmatterSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'name must be kebab-case'),
  description: z.string().min(1, 'description is required'),

  // Model
  model: z.string().default('inherit'),
  provider: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  effort: z.enum(['low', 'medium', 'high', 'max']).optional(),

  // Tool access
  tools: z.array(z.string()).optional(),
  toolsDeny: z.array(z.string()).optional(),

  // Skills
  skills: z.array(z.string()).optional(),

  // Delegation
  agents: z.array(z.string()).optional(),
  maxDepth: z.number().int().min(0).default(1),
  handoffs: z
    .array(
      z.object({
        label: z.string(),
        agent: z.string(),
        prompt: z.string(),
        send: z.enum(['result', 'none']).optional(),
      }),
    )
    .optional(),

  // Memory
  //
  // A.0.2 — Phase A foundation hardening:
  // The schema accepts the full set of scopes for forward-compatibility with
  // Phase C, but ONLY `none` is implemented. Any other value is currently a
  // no-op that previously silently misled authors of `memory: user` agents.
  // We accept other values at parse time and downgrade them to `none` with a
  // logged warning so the broken expectation surfaces. Phase C will wire the
  // real per-scope memory loader at this site.
  memory: z
    .enum(['none', 'project', 'user', 'local'])
    .default('none')
    .transform((scope) => {
      if (scope === 'none') return scope;
      // We have no access to the source path here — emit the warning with the
      // scope so the operator can grep for it. The transform always coerces
      // to 'none' so downstream code can rely on the field's contract.
      console.warn(
        `[AgentRegistry] memory: '${scope}' is declared but not yet implemented (Phase C). Treating as 'none'. See plans/odysseus-competitive-analysis.md A.0.2.`,
      );
      return 'none' as const;
    }),

  // UI
  color: AgentColorSchema.default('cyan'),
  icon: z.string().default('🤖'),

  // Invocation
  userInvocable: z.boolean().default(true),
  maxTurns: z.number().int().min(1).default(10),
  timeoutMs: z.number().int().min(1000).default(600_000),

  // Auto-invoke (not MVP)
  autoInvoke: z
    .array(
      z.object({
        on: z.enum(['file-change', 'keyword']),
        pattern: z.string(),
      }),
    )
    .optional(),
});

/**
 * Parse a raw .md file string into a validated AgentDef.
 * Throws a ZodError (or Error) if the file is invalid.
 */
export function parseAgentFile(
  raw: string,
  sourcePath: string,
  source: 'builtin' | 'user' | 'project',
): AgentDef {
  const parsed = matter(raw);

  const fm = AgentDefFrontmatterSchema.parse(parsed.data);
  const systemPrompt = (parsed.content ?? '').trim();

  return {
    name: fm.name,
    description: fm.description,
    systemPrompt,
    model: fm.model,
    ...(fm.provider !== undefined ? { provider: fm.provider } : {}),
    ...(fm.temperature !== undefined ? { temperature: fm.temperature } : {}),
    ...(fm.effort !== undefined ? { effort: fm.effort } : {}),
    ...(fm.tools !== undefined ? { tools: fm.tools } : {}),
    ...(fm.toolsDeny !== undefined ? { toolsDeny: fm.toolsDeny } : {}),
    ...(fm.skills !== undefined ? { skills: fm.skills } : {}),
    ...(fm.agents !== undefined ? { agents: fm.agents } : {}),
    maxDepth: fm.maxDepth,
    ...(fm.handoffs !== undefined
      ? {
          handoffs: fm.handoffs.map((h) => ({
            label: h.label,
            agent: h.agent,
            prompt: h.prompt,
            ...(h.send !== undefined ? { send: h.send } : {}),
          })),
        }
      : {}),
    memory: fm.memory,
    color: fm.color as AgentDef['color'],
    icon: fm.icon,
    userInvocable: fm.userInvocable,
    maxTurns: fm.maxTurns,
    timeoutMs: fm.timeoutMs,
    ...(fm.autoInvoke !== undefined ? { autoInvoke: fm.autoInvoke } : {}),
    source,
    sourcePath,
  };
}
