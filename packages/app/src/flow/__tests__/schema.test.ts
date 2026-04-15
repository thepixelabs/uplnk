/**
 * Tests for the flow YAML schema (schema.ts).
 *
 * We verify what the schema accepts and rejects, including the recursive
 * step nesting that z.lazy() enables. We do NOT test that z.string() rejects
 * numbers — that is Zod's job. We test the application-level constraints:
 * field names, discriminant values, nested step structures, and defaults.
 */

import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { FlowDef, ChatStep, ToolStep } from '../schema.js';

// ─── Minimal valid inputs ─────────────────────────────────────────────────────

const MINIMAL_CHAT_STEP = {
  id: 'step1',
  type: 'chat' as const,
  prompt: 'Say hello.',
};

const MINIMAL_FLOW = {
  apiVersion: 'uplnk.io/v1' as const,
  name: 'my-flow',
  steps: [MINIMAL_CHAT_STEP],
};

// ─── FlowDef — valid minimal ──────────────────────────────────────────────────

describe('FlowDef — minimal valid flow', () => {
  it('parses a flow with only required fields', () => {
    const result = FlowDef.parse(MINIMAL_FLOW);
    expect(result.apiVersion).toBe('uplnk.io/v1');
    expect(result.name).toBe('my-flow');
    expect(result.steps).toHaveLength(1);
  });

  it('defaults inputs to an empty record when omitted', () => {
    const result = FlowDef.parse(MINIMAL_FLOW);
    expect(result.inputs).toEqual({});
  });

  it('defaults retries to 0 on a step when not specified', () => {
    const result = FlowDef.parse(MINIMAL_FLOW);
    expect((result.steps[0] as ReturnType<typeof ChatStep.parse>).retries).toBe(0);
  });
});

// ─── FlowDef — name pattern ───────────────────────────────────────────────────

describe('FlowDef — name validation', () => {
  it('accepts kebab-case names', () => {
    const result = FlowDef.parse({ ...MINIMAL_FLOW, name: 'my-flow-v2' });
    expect(result.name).toBe('my-flow-v2');
  });

  it('accepts names with digits after the first character', () => {
    const result = FlowDef.parse({ ...MINIMAL_FLOW, name: 'flow2' });
    expect(result.name).toBe('flow2');
  });

  it('accepts underscore in names', () => {
    const result = FlowDef.parse({ ...MINIMAL_FLOW, name: 'my_flow' });
    expect(result.name).toBe('my_flow');
  });

  it('rejects names that start with a digit', () => {
    expect(() => FlowDef.parse({ ...MINIMAL_FLOW, name: '1flow' })).toThrow(ZodError);
  });

  it('rejects names that start with uppercase', () => {
    expect(() => FlowDef.parse({ ...MINIMAL_FLOW, name: 'MyFlow' })).toThrow(ZodError);
  });

  it('rejects a single-character name (pattern requires at least 2 chars)', () => {
    // Regex /^[a-z][a-z0-9_-]+$/ requires [a-z] then one-or-more [a-z0-9_-]
    expect(() => FlowDef.parse({ ...MINIMAL_FLOW, name: 'x' })).toThrow(ZodError);
  });

  it('rejects names with spaces', () => {
    expect(() => FlowDef.parse({ ...MINIMAL_FLOW, name: 'my flow' })).toThrow(ZodError);
  });
});

// ─── FlowDef — apiVersion ─────────────────────────────────────────────────────

describe('FlowDef — apiVersion', () => {
  it('rejects an unknown apiVersion literal', () => {
    expect(() => FlowDef.parse({ ...MINIMAL_FLOW, apiVersion: 'v2' })).toThrow(ZodError);
  });

  it('rejects a missing apiVersion', () => {
    const { apiVersion: _, ...noVersion } = MINIMAL_FLOW;
    expect(() => FlowDef.parse(noVersion)).toThrow(ZodError);
  });
});

// ─── FlowDef — steps required ────────────────────────────────────────────────

describe('FlowDef — steps constraint', () => {
  it('rejects an empty steps array', () => {
    expect(() => FlowDef.parse({ ...MINIMAL_FLOW, steps: [] })).toThrow(ZodError);
  });

  it('rejects a missing steps field', () => {
    const { steps: _, ...noSteps } = MINIMAL_FLOW;
    expect(() => FlowDef.parse(noSteps)).toThrow(ZodError);
  });
});

// ─── FlowDef — description and outputs (optional) ────────────────────────────

describe('FlowDef — optional top-level fields', () => {
  it('accepts a description', () => {
    const result = FlowDef.parse({ ...MINIMAL_FLOW, description: 'Does things.' });
    expect(result.description).toBe('Does things.');
  });

  it('accepts an outputs record', () => {
    const result = FlowDef.parse({ ...MINIMAL_FLOW, outputs: { result: 'steps.step1.output' } });
    expect(result.outputs?.result).toBe('steps.step1.output');
  });
});

// ─── Input parameter types ────────────────────────────────────────────────────

describe('FlowDef — input parameter types', () => {
  it('accepts all declared input types: string, number, boolean, array, object', () => {
    const result = FlowDef.parse({
      ...MINIMAL_FLOW,
      inputs: {
        query: { type: 'string', required: true },
        maxRetries: { type: 'number', default: 3 },
        verbose: { type: 'boolean', default: false },
        tags: { type: 'array' },
        config: { type: 'object' },
      },
    });
    expect(Object.keys(result.inputs)).toHaveLength(5);
    expect(result.inputs['query']?.type).toBe('string');
    expect(result.inputs['maxRetries']?.default).toBe(3);
  });

  it('defaults required to false when omitted on an input', () => {
    const result = FlowDef.parse({
      ...MINIMAL_FLOW,
      inputs: { msg: { type: 'string' } },
    });
    expect(result.inputs['msg']?.required).toBe(false);
  });

  it('rejects an unknown input type', () => {
    expect(() =>
      FlowDef.parse({
        ...MINIMAL_FLOW,
        inputs: { bad: { type: 'bigint' } },
      })
    ).toThrow(ZodError);
  });
});

// ─── ChatStep ─────────────────────────────────────────────────────────────────

describe('ChatStep', () => {
  it('parses a minimal chat step', () => {
    const result = ChatStep.parse(MINIMAL_CHAT_STEP);
    expect(result.type).toBe('chat');
    expect(result.prompt).toBe('Say hello.');
    expect(result.retries).toBe(0);
  });

  it('accepts all optional fields', () => {
    const result = ChatStep.parse({
      ...MINIMAL_CHAT_STEP,
      name: 'Greeting',
      provider: 'anthropic',
      model: 'claude-opus-4',
      system: 'Be helpful.',
      outputVar: 'greeting',
      when: 'inputs.enabled',
      retries: 2,
      timeoutMs: 30000,
    });
    expect(result.provider).toBe('anthropic');
    expect(result.outputVar).toBe('greeting');
    expect(result.retries).toBe(2);
    expect(result.timeoutMs).toBe(30000);
  });

  it('rejects a chat step missing the prompt', () => {
    const { prompt: _, ...noPrompt } = MINIMAL_CHAT_STEP;
    expect(() => ChatStep.parse(noPrompt)).toThrow(ZodError);
  });

  it('rejects a negative retries value', () => {
    expect(() => ChatStep.parse({ ...MINIMAL_CHAT_STEP, retries: -1 })).toThrow(ZodError);
  });

  it('rejects a non-integer retries value', () => {
    expect(() => ChatStep.parse({ ...MINIMAL_CHAT_STEP, retries: 1.5 })).toThrow(ZodError);
  });

  it('rejects a zero timeoutMs (must be positive)', () => {
    expect(() => ChatStep.parse({ ...MINIMAL_CHAT_STEP, timeoutMs: 0 })).toThrow(ZodError);
  });
});

// ─── ToolStep ─────────────────────────────────────────────────────────────────

describe('ToolStep', () => {
  const MINIMAL_TOOL_STEP = {
    id: 'run-tool',
    type: 'tool' as const,
    tool: 'web-search',
    args: { query: 'uplnk' },
  };

  it('parses a minimal tool step', () => {
    const result = ToolStep.parse(MINIMAL_TOOL_STEP);
    expect(result.type).toBe('tool');
    expect(result.tool).toBe('web-search');
    expect(result.args).toEqual({ query: 'uplnk' });
  });

  it('accepts an outputVar', () => {
    const result = ToolStep.parse({ ...MINIMAL_TOOL_STEP, outputVar: 'searchResult' });
    expect(result.outputVar).toBe('searchResult');
  });

  it('accepts an empty args record', () => {
    const result = ToolStep.parse({ ...MINIMAL_TOOL_STEP, args: {} });
    expect(result.args).toEqual({});
  });

  it('rejects a tool step missing tool', () => {
    const { tool: _, ...noTool } = MINIMAL_TOOL_STEP;
    expect(() => ToolStep.parse(noTool)).toThrow(ZodError);
  });

  it('rejects a tool step missing args', () => {
    const { args: _, ...noArgs } = MINIMAL_TOOL_STEP;
    expect(() => ToolStep.parse(noArgs)).toThrow(ZodError);
  });
});

// ─── Step id pattern ──────────────────────────────────────────────────────────

describe('StepBase — id validation', () => {
  it('accepts a step id that starts with a lowercase letter', () => {
    const result = ChatStep.parse({ ...MINIMAL_CHAT_STEP, id: 'my-step-1' });
    expect(result.id).toBe('my-step-1');
  });

  it('rejects a step id that starts with a digit', () => {
    expect(() => ChatStep.parse({ ...MINIMAL_CHAT_STEP, id: '1step' })).toThrow(ZodError);
  });

  it('rejects a step id with uppercase letters', () => {
    expect(() => ChatStep.parse({ ...MINIMAL_CHAT_STEP, id: 'MyStep' })).toThrow(ZodError);
  });

  it('rejects a step id with spaces', () => {
    expect(() => ChatStep.parse({ ...MINIMAL_CHAT_STEP, id: 'my step' })).toThrow(ZodError);
  });
});

// ─── ConditionStep ────────────────────────────────────────────────────────────

describe('ConditionStep (via FlowDef)', () => {
  const flowWithCondition = {
    ...MINIMAL_FLOW,
    steps: [
      {
        id: 'branch',
        type: 'condition' as const,
        expr: 'inputs.enabled',
        then: [MINIMAL_CHAT_STEP],
      },
    ],
  };

  it('parses a condition step with required then branch', () => {
    const result = FlowDef.parse(flowWithCondition);
    const step = result.steps[0] as { type: string; expr: string; then: unknown[] };
    expect(step.type).toBe('condition');
    expect(step.expr).toBe('inputs.enabled');
    expect(step.then).toHaveLength(1);
  });

  it('parses a condition step with optional else branch', () => {
    const result = FlowDef.parse({
      ...MINIMAL_FLOW,
      steps: [
        {
          id: 'branch',
          type: 'condition' as const,
          expr: 'vars.ready',
          then: [MINIMAL_CHAT_STEP],
          else: [{ id: 'fallback', type: 'chat' as const, prompt: 'Not ready.' }],
        },
      ],
    });
    const step = result.steps[0] as { else?: unknown[] };
    expect(step.else).toHaveLength(1);
  });

  it('rejects a condition step missing expr', () => {
    expect(() =>
      FlowDef.parse({
        ...MINIMAL_FLOW,
        steps: [{ id: 'c', type: 'condition', then: [MINIMAL_CHAT_STEP] }],
      })
    ).toThrow(ZodError);
  });

  it('rejects a condition step missing then', () => {
    expect(() =>
      FlowDef.parse({
        ...MINIMAL_FLOW,
        steps: [{ id: 'c', type: 'condition', expr: 'true' }],
      })
    ).toThrow(ZodError);
  });
});

// ─── LoopStep ─────────────────────────────────────────────────────────────────

describe('LoopStep (via FlowDef)', () => {
  const whileStep = {
    id: 'retry-loop',
    type: 'loop' as const,
    kind: 'while' as const,
    expr: 'vars.retries < 3',
    body: [MINIMAL_CHAT_STEP],
  };

  const forEachStep = {
    id: 'item-loop',
    type: 'loop' as const,
    kind: 'forEach' as const,
    items: 'inputs.list',
    as: 'item',
    body: [MINIMAL_CHAT_STEP],
  };

  it('parses a while loop', () => {
    const result = FlowDef.parse({ ...MINIMAL_FLOW, steps: [whileStep] });
    const step = result.steps[0] as { type: string; kind: string; maxIterations: number };
    expect(step.type).toBe('loop');
    expect(step.kind).toBe('while');
    expect(step.maxIterations).toBe(100); // default
  });

  it('parses a forEach loop', () => {
    const result = FlowDef.parse({ ...MINIMAL_FLOW, steps: [forEachStep] });
    const step = result.steps[0] as { kind: string; items?: string; as?: string };
    expect(step.kind).toBe('forEach');
    expect(step.items).toBe('inputs.list');
    expect(step.as).toBe('item');
  });

  it('accepts an explicit maxIterations override', () => {
    const result = FlowDef.parse({ ...MINIMAL_FLOW, steps: [{ ...whileStep, maxIterations: 50 }] });
    const step = result.steps[0] as { maxIterations: number };
    expect(step.maxIterations).toBe(50);
  });

  it('rejects a loop with an unknown kind', () => {
    expect(() =>
      FlowDef.parse({
        ...MINIMAL_FLOW,
        steps: [{ ...whileStep, kind: 'repeat' }],
      })
    ).toThrow(ZodError);
  });

  it('rejects a loop missing body', () => {
    const { body: _, ...noBody } = whileStep;
    expect(() =>
      FlowDef.parse({ ...MINIMAL_FLOW, steps: [noBody] })
    ).toThrow(ZodError);
  });

  it('rejects a non-positive maxIterations', () => {
    expect(() =>
      FlowDef.parse({ ...MINIMAL_FLOW, steps: [{ ...whileStep, maxIterations: 0 }] })
    ).toThrow(ZodError);
  });
});

// ─── Unknown step type ────────────────────────────────────────────────────────

describe('AnyStep — unknown step type is rejected', () => {
  it('rejects a step with an unrecognised type', () => {
    expect(() =>
      FlowDef.parse({
        ...MINIMAL_FLOW,
        steps: [{ id: 'bad', type: 'script', command: 'ls' }],
      })
    ).toThrow(ZodError);
  });

  it('rejects a step with type omitted', () => {
    expect(() =>
      FlowDef.parse({
        ...MINIMAL_FLOW,
        steps: [{ id: 'bad', prompt: 'hello' }],
      })
    ).toThrow(ZodError);
  });
});

// ─── Recursive step nesting ───────────────────────────────────────────────────

describe('recursive step nesting via z.lazy', () => {
  it('parses a condition inside a loop body (two levels deep)', () => {
    const flow = {
      ...MINIMAL_FLOW,
      steps: [
        {
          id: 'outer-loop',
          type: 'loop' as const,
          kind: 'while' as const,
          expr: 'true',
          body: [
            {
              id: 'inner-branch',
              type: 'condition' as const,
              expr: 'vars.flag',
              then: [{ id: 'inner-chat', type: 'chat' as const, prompt: 'Deep step.' }],
            },
          ],
        },
      ],
    };

    const result = FlowDef.parse(flow);
    const loop = result.steps[0] as { body: { type: string; then: { type: string }[] }[] };
    expect(loop.body[0]?.type).toBe('condition');
    expect(loop.body[0]?.then[0]?.type).toBe('chat');
  });

  it('parses a loop inside a condition then branch (two levels deep)', () => {
    const flow = {
      ...MINIMAL_FLOW,
      steps: [
        {
          id: 'outer-cond',
          type: 'condition' as const,
          expr: 'inputs.enabled',
          then: [
            {
              id: 'inner-loop',
              type: 'loop' as const,
              kind: 'forEach' as const,
              items: 'inputs.items',
              body: [MINIMAL_CHAT_STEP],
            },
          ],
        },
      ],
    };

    const result = FlowDef.parse(flow);
    const cond = result.steps[0] as { then: { type: string }[] };
    expect(cond.then[0]?.type).toBe('loop');
  });
});
