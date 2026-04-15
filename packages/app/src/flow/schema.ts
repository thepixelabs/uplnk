import { z } from 'zod';

const StepBase = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  name: z.string().optional(),
  when: z.string().optional(),
  retries: z.number().int().min(0).default(0),
  timeoutMs: z.number().int().positive().optional(),
});

export const ChatStep = StepBase.extend({
  type: z.literal('chat'),
  provider: z.string().optional(),
  model: z.string().optional(),
  system: z.string().optional(),
  prompt: z.string(),
  outputVar: z.string().optional(),
});

export const ToolStep = StepBase.extend({
  type: z.literal('tool'),
  tool: z.string(),
  args: z.record(z.unknown()),
  outputVar: z.string().optional(),
});

export const ConditionStep: z.ZodType = z.lazy(() =>
  StepBase.extend({
    type: z.literal('condition'),
    expr: z.string(),
    then: z.array(AnyStep),
    else: z.array(AnyStep).optional(),
  })
);

export const LoopStep: z.ZodType = z.lazy(() =>
  StepBase.extend({
    type: z.literal('loop'),
    kind: z.enum(['while', 'forEach']),
    expr: z.string().optional(),
    items: z.string().optional(),
    as: z.string().optional(),
    maxIterations: z.number().int().positive().default(100),
    body: z.array(AnyStep),
  })
);

// discriminatedUnion requires ZodObject children — lazy wrappers lose the
// discriminant shape at compile time. We use a plain z.union here instead,
// accepting the slightly-weaker parse-time discriminant check in exchange for
// recursive step nesting. Runtime validation still works correctly because
// each variant's literal 'type' field acts as the discriminant.
export const AnyStep: z.ZodType = z.union([
  ChatStep,
  ToolStep,
  z.lazy(() => ConditionStep) as z.ZodType,
  z.lazy(() => LoopStep) as z.ZodType,
]);

export const FlowDef = z.object({
  apiVersion: z.literal('uplnk.io/v1'),
  name: z.string().regex(/^[a-z][a-z0-9_-]+$/),
  description: z.string().optional(),
  inputs: z
    .record(
      z.object({
        type: z.enum(['string', 'number', 'boolean', 'array', 'object']),
        default: z.unknown().optional(),
        required: z.boolean().default(false),
      }),
    )
    .default({}),
  steps: z.array(AnyStep).min(1),
  outputs: z.record(z.string()).optional(),
});

export type FlowDef = z.infer<typeof FlowDef>;
export type ChatStep = z.infer<typeof ChatStep>;
export type ToolStep = z.infer<typeof ToolStep>;

// For condition/loop steps the recursive lazy schema means we need explicit
// types here. The infer would be recursive which TypeScript handles but we
// provide a clean structural type that matches the runtime shape.
export interface ConditionStepType {
  type: 'condition';
  id: string;
  name?: string;
  when?: string;
  retries: number;
  timeoutMs?: number;
  expr: string;
  then: AnyStepType[];
  else?: AnyStepType[];
}

export interface LoopStepType {
  type: 'loop';
  id: string;
  name?: string;
  when?: string;
  retries: number;
  timeoutMs?: number;
  kind: 'while' | 'forEach';
  expr?: string;
  items?: string;
  as?: string;
  maxIterations: number;
  body: AnyStepType[];
}

export type AnyStepType = ChatStep | ToolStep | ConditionStepType | LoopStepType;
