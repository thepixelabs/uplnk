import { z } from 'zod';

// Relay file stored at ~/.uplnk/relays/<id>.json
// The `id` field MUST match the filename stem.

export const RelayPhaseSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  systemPrompt: z.string().default(''),
  maxOutputTokens: z.number().int().positive().max(32768).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

export const RelayPlanSchema = z.object({
  version: z.literal(1),
  id: z
    .string()
    .min(1)
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      'id must be alphanumeric, hyphens or underscores',
    ),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  scout: RelayPhaseSchema,
  anchor: RelayPhaseSchema.extend({
    mcpEnabled: z.boolean().default(true),
  }),
});

export type RelayPlan = z.infer<typeof RelayPlanSchema>;
export type RelayPhaseConfig = z.infer<typeof RelayPhaseSchema>;
