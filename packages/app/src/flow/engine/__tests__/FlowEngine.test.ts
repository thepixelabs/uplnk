/**
 * FlowEngine — unit tests
 *
 * Strategy:
 * - All AI SDK calls (streamText) are mocked at the module boundary.
 * - @uplnk/db is stubbed by the global setup (setup.ts). We override
 *   individual exports with vi.mocked() per-test to control return values.
 * - languageModelFactory and secrets are mocked so FlowEngine never
 *   touches real network or the filesystem.
 * - fetch is mocked globally for the builtin:http tool tests.
 * - Fake timers are used only where step-timeout behaviour is under test;
 *   the global afterEach in setup.ts restores real timers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted mock refs ─────────────────────────────────────────────────────────

const aiMocks = vi.hoisted(() => ({ streamText: vi.fn() }));

// ─── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('ai', () => ({ streamText: aiMocks.streamText }));

vi.mock('../../../lib/languageModelFactory.js', () => ({
  createLanguageModel: vi.fn(() => ({ specificationVersion: 'v1', provider: 'fake', modelId: 'fake' })),
}));

vi.mock('../../../lib/secrets.js', () => ({
  resolveSecret: vi.fn(() => 'test-api-key'),
}));

// flowRepo calls are already satisfied by the @uplnk/db global stub, but
// flowRepo itself also calls db directly — replace it entirely so FlowEngine
// does not depend on DB state in these tests.
vi.mock('../../persistence/flowRepo.js', () => ({
  upsertFlow: vi.fn(() => 'flow-id-1'),
  createFlowRun: vi.fn(() => 'run-id-1'),
  updateFlowRun: vi.fn(),
  upsertStepResult: vi.fn(),
}));

// ─── Imports under test ────────────────────────────────────────────────────────

import { FlowEngine } from '../FlowEngine.js';
import type { FlowEvent } from '../FlowEngine.js';
import type { LoadedFlow } from '../../loader.js';
import type { FlowDef } from '../../schema.js';
import {
  upsertFlow as mockUpsertFlow,
  createFlowRun as mockCreateFlowRun,
  updateFlowRun as mockUpdateFlowRun,
  upsertStepResult as mockUpsertStepResult,
} from '../../persistence/flowRepo.js';
import { getDefaultProvider } from '@uplnk/db';
import { makeFakeProviderRow } from '../../../__tests__/helpers/fakeProviderRow.js';
import { makeTestConfig } from '../../../__tests__/fixtures/config.js';

// ─── Factories ─────────────────────────────────────────────────────────────────

function makeLoadedFlow(def: Partial<FlowDef> & { name: string; steps: FlowDef['steps'] }): LoadedFlow {
  return {
    path: `/tmp/flows/${def.name}.yaml`,
    hash: 'abc123',
    def: {
      apiVersion: 'uplnk.io/v1',
      inputs: {},
      ...def,
    } as FlowDef,
  };
}

function makeChatFlow(prompt = 'say hello'): LoadedFlow {
  return makeLoadedFlow({
    name: 'chat-flow',
    steps: [{ id: 'greet', type: 'chat', prompt, retries: 0 }],
  });
}

/** Build an async iterable of stream events from text deltas */
function makeFullStream(deltas: string[], errorEvent?: Error): AsyncIterable<unknown> {
  return (async function* () {
    for (const delta of deltas) {
      yield { type: 'text-delta', textDelta: delta };
    }
    if (errorEvent !== undefined) {
      yield { type: 'error', error: errorEvent };
    } else {
      yield { type: 'finish', usage: { promptTokens: 5, completionTokens: 10 }, finishReason: 'stop' };
    }
  })();
}

// ─── Shared state ──────────────────────────────────────────────────────────────

let engine: FlowEngine;

beforeEach(() => {
  vi.mocked(getDefaultProvider).mockReturnValue(makeFakeProviderRow());
  engine = new FlowEngine(makeTestConfig({ flows: { ...makeTestConfig().flows, allowHttpStep: true } }));
  aiMocks.streamText.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FlowEngine', () => {

  // ── Provider resolution ───────────────────────────────────────────────────

  describe('provider resolution', () => {
    it('throws when no provider is configured and none specified on step', async () => {
      vi.mocked(getDefaultProvider).mockReturnValue(undefined);

      await expect(engine.run(makeChatFlow())).rejects.toThrow('No provider configured');
    });

    it('uses the default DB provider when no step.provider is specified', async () => {
      const provider = makeFakeProviderRow({ id: 'default-prov' });
      vi.mocked(getDefaultProvider).mockReturnValue(provider);

      aiMocks.streamText.mockReturnValueOnce({ fullStream: makeFullStream(['hi']) });

      await engine.run(makeChatFlow());

      // The AI call must have been made — engine did not throw
      expect(aiMocks.streamText).toHaveBeenCalledOnce();
    });
  });

  // ── Input resolution ──────────────────────────────────────────────────────

  describe('input resolution', () => {
    it('throws when a required input is missing', async () => {
      const flow = makeLoadedFlow({
        name: 'requires-name',
        inputs: { name: { type: 'string', required: true } },
        steps: [{ id: 's1', type: 'chat', prompt: 'hello', retries: 0 }],
      });

      await expect(engine.run(flow, { inputs: {} })).rejects.toThrow(
        'Required input "name" was not provided',
      );
    });

    it('uses the declared default when an optional input is not supplied', async () => {
      aiMocks.streamText.mockReturnValueOnce({ fullStream: makeFullStream(['ok']) });

      const flow = makeLoadedFlow({
        name: 'with-default',
        inputs: { greeting: { type: 'string', default: 'hello', required: false } },
        steps: [{ id: 's1', type: 'chat', prompt: '${inputs.greeting}', retries: 0 }],
      });

      const events: FlowEvent[] = [];
      await engine.run(flow, { onEvent: (e) => events.push(e) });

      const streamCall = aiMocks.streamText.mock.calls[0]?.[0] as { messages: Array<{ role: string; content: string }> };
      const userMessage = streamCall.messages.find((m) => m.role === 'user');
      expect(userMessage?.content).toBe('hello');
    });

    it('passes through caller-supplied extra inputs not declared in the schema', async () => {
      aiMocks.streamText.mockReturnValueOnce({ fullStream: makeFullStream(['ok']) });

      const flow = makeLoadedFlow({
        name: 'extra-inputs',
        steps: [{ id: 's1', type: 'chat', prompt: '${inputs.extra}', retries: 0 }],
      });

      await engine.run(flow, { inputs: { extra: 'bonus' } });

      const streamCall = aiMocks.streamText.mock.calls[0]?.[0] as { messages: Array<{ role: string; content: string }> };
      const userMessage = streamCall.messages.find((m) => m.role === 'user');
      expect(userMessage?.content).toBe('bonus');
    });
  });

  // ── Chat step ─────────────────────────────────────────────────────────────

  describe('chat step', () => {
    it('returns the concatenated text from all stream deltas', async () => {
      aiMocks.streamText.mockReturnValueOnce({ fullStream: makeFullStream(['Hello', ', ', 'world!']) });

      const result = await engine.run(makeChatFlow());

      // When no outputs map is declared, stepOutputs is returned directly
      expect(result['greet']).toBe('Hello, world!');
    });

    it('emits step.stream events for each text-delta', async () => {
      aiMocks.streamText.mockReturnValueOnce({ fullStream: makeFullStream(['foo', 'bar']) });

      const streamEvents: FlowEvent[] = [];
      await engine.run(makeChatFlow(), {
        onEvent: (e) => { if (e.kind === 'step.stream') streamEvents.push(e); },
      });

      expect(streamEvents).toHaveLength(2);
      expect(streamEvents[0]?.text).toBe('foo');
      expect(streamEvents[1]?.text).toBe('bar');
    });

    it('includes a system message when step.system is set', async () => {
      aiMocks.streamText.mockReturnValueOnce({ fullStream: makeFullStream(['ok']) });

      const flow = makeLoadedFlow({
        name: 'with-system',
        steps: [{ id: 's1', type: 'chat', prompt: 'hi', system: 'You are a pirate.', retries: 0 }],
      });

      await engine.run(flow);

      const streamCall = aiMocks.streamText.mock.calls[0]?.[0] as { messages: Array<{ role: string; content: string }> };
      const sysMessage = streamCall.messages.find((m) => m.role === 'system');
      expect(sysMessage?.content).toBe('You are a pirate.');
    });

    it('interpolates ${steps.stepId.output} from prior step output into the prompt', async () => {
      // Two sequential chat steps — the second references the first's output.
      // Note: step IDs must be valid identifiers (no hyphens) since the expr
      // tokenizer stops at non-alphanumeric characters.
      aiMocks.streamText
        .mockReturnValueOnce({ fullStream: makeFullStream(['FIRST_OUTPUT']) })
        .mockReturnValueOnce({ fullStream: makeFullStream(['ok']) });

      const flow = makeLoadedFlow({
        name: 'chained',
        steps: [
          { id: 'stepa', type: 'chat', prompt: 'generate something', retries: 0 },
          { id: 'stepb', type: 'chat', prompt: 'summarise: ${steps.stepa.output}', retries: 0 },
        ],
      });

      await engine.run(flow);

      const secondCall = aiMocks.streamText.mock.calls[1]?.[0] as { messages: Array<{ role: string; content: string }> };
      const userMsg = secondCall.messages.find((m) => m.role === 'user');
      expect(userMsg?.content).toBe('summarise: FIRST_OUTPUT');
    });

    it('stores step output in outputVar when declared', async () => {
      aiMocks.streamText.mockReturnValueOnce({ fullStream: makeFullStream(['stored']) });

      const flow = makeLoadedFlow({
        name: 'with-output-var',
        steps: [{ id: 's1', type: 'chat', prompt: 'hi', outputVar: 'myVar', retries: 0 }],
      });

      const events: FlowEvent[] = [];
      await engine.run(flow, { onEvent: (e) => events.push(e) });

      const doneEvent = events.find((e) => e.kind === 'step.done');
      expect(doneEvent?.output).toBe('stored');
    });

    it('throws and emits step.error when the stream yields an error event', async () => {
      const streamError = new Error('LLM API exploded');
      aiMocks.streamText.mockReturnValueOnce({ fullStream: makeFullStream([], streamError) });

      const errorEvents: FlowEvent[] = [];
      await expect(
        engine.run(makeChatFlow(), { onEvent: (e) => { if (e.kind === 'step.error') errorEvents.push(e); } }),
      ).rejects.toThrow('LLM API exploded');

      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]?.error).toBe('LLM API exploded');
    });
  });

  // ── ${inputs.name} interpolation ──────────────────────────────────────────

  describe('${inputs.name} interpolation', () => {
    it('replaces ${inputs.x} placeholders in the prompt', async () => {
      aiMocks.streamText.mockReturnValueOnce({ fullStream: makeFullStream(['pong']) });

      const flow = makeLoadedFlow({
        name: 'input-interp',
        inputs: { subject: { type: 'string', required: true } },
        steps: [{ id: 's1', type: 'chat', prompt: 'Tell me about ${inputs.subject}', retries: 0 }],
      });

      await engine.run(flow, { inputs: { subject: 'TypeScript' } });

      const call = aiMocks.streamText.mock.calls[0]?.[0] as { messages: Array<{ role: string; content: string }> };
      const msg = call.messages.find((m) => m.role === 'user');
      expect(msg?.content).toBe('Tell me about TypeScript');
    });
  });

  // ── Condition step ────────────────────────────────────────────────────────

  describe('condition step', () => {
    it('executes the then branch when the expression is truthy', async () => {
      aiMocks.streamText.mockReturnValueOnce({ fullStream: makeFullStream(['then-result']) });

      const flow = makeLoadedFlow({
        name: 'condition-true',
        steps: [
          {
            id: 'branch',
            type: 'condition',
            expr: 'true',
            then: [{ id: 'then-step', type: 'chat', prompt: 'true branch', retries: 0 }],
            else: [],
            retries: 0,
          },
        ],
      });

      const result = await engine.run(flow);

      expect(aiMocks.streamText).toHaveBeenCalledOnce();
      expect(result['then-step']).toBe('then-result');
    });

    it('executes the else branch when the expression is falsy', async () => {
      aiMocks.streamText.mockReturnValueOnce({ fullStream: makeFullStream(['else-result']) });

      const flow = makeLoadedFlow({
        name: 'condition-false',
        steps: [
          {
            id: 'branch',
            type: 'condition',
            expr: 'false',
            then: [],
            else: [{ id: 'else-step', type: 'chat', prompt: 'false branch', retries: 0 }],
            retries: 0,
          },
        ],
      });

      const result = await engine.run(flow);

      expect(aiMocks.streamText).toHaveBeenCalledOnce();
      expect(result['else-step']).toBe('else-result');
    });

    it('skips both branches when expression is false and else is absent', async () => {
      const flow = makeLoadedFlow({
        name: 'no-else',
        steps: [
          {
            id: 'branch',
            type: 'condition',
            expr: 'false',
            then: [{ id: 'skipped', type: 'chat', prompt: 'never', retries: 0 }],
            retries: 0,
          },
        ],
      });

      await engine.run(flow);

      expect(aiMocks.streamText).not.toHaveBeenCalled();
    });

    it('evaluates a step-output comparison expression correctly', async () => {
      aiMocks.streamText
        .mockReturnValueOnce({ fullStream: makeFullStream(['yes']) })   // first step
        .mockReturnValueOnce({ fullStream: makeFullStream(['branched']) }); // then branch

      const flow = makeLoadedFlow({
        name: 'step-output-cond',
        steps: [
          { id: 'first', type: 'chat', prompt: 'return yes', retries: 0 },
          {
            id: 'cond',
            type: 'condition',
            expr: 'steps.first.output == "yes"',
            then: [{ id: 'then-chat', type: 'chat', prompt: 'matched', retries: 0 }],
            retries: 0,
          },
        ],
      });

      const result = await engine.run(flow);

      expect(result['then-chat']).toBe('branched');
    });
  });

  // ── Loop step (forEach) ───────────────────────────────────────────────────
  //
  // DESIGN LIMITATION (documented by tests below):
  // The loop's `items` expression is resolved through expr.ts's `resolveExpression`.
  // That function routes all path lookups through `coercePrimitive()`, which
  // converts any non-scalar value (including arrays) to a string via String().
  // Since `Array.isArray(string)` is always false, forEach loops whose items
  // are stored in inputs or vars as real JS arrays will always iterate over
  // zero items. The only way to iterate is to have an already-stringified
  // path resolve to an Array — which the parser cannot produce.
  //
  // This is a known limitation. Tests below document current behaviour.

  describe('loop step — forEach', () => {
    it('runs zero body iterations when items resolves to a non-array (expr limitation)', async () => {
      // Even though inputs.list = ['a','b'], expr.ts coerces it to the string
      // "a,b" which fails the Array.isArray check → items = [] → 0 iterations.
      const flow = makeLoadedFlow({
        name: 'foreach-flow',
        inputs: { list: { type: 'array', required: true } },
        steps: [
          {
            id: 'each',
            type: 'loop',
            kind: 'forEach',
            items: 'inputs.list',
            body: [{ id: 'bodystep', type: 'chat', prompt: 'hi', retries: 0 }],
            maxIterations: 10,
            retries: 0,
          },
        ],
      });

      // No error, zero LLM calls — the loop silently iterates nothing
      await engine.run(flow, { inputs: { list: ['a', 'b'] } });

      expect(aiMocks.streamText).not.toHaveBeenCalled();
    });

    it('returns null as the loop step output when no items are iterated', async () => {
      const flow = makeLoadedFlow({
        name: 'empty-foreach',
        inputs: { list: { type: 'array', required: true } },
        steps: [
          {
            id: 'each',
            type: 'loop',
            kind: 'forEach',
            items: 'inputs.list',
            body: [{ id: 'bodystep', type: 'chat', prompt: 'hi', retries: 0 }],
            maxIterations: 10,
            retries: 0,
          },
        ],
      });

      const result = await engine.run(flow, { inputs: { list: ['a', 'b'] } });

      expect(result['each']).toBeNull();
    });

    it('does not exceed maxIterations because zero items are iterated', async () => {
      // maxIterations: 1 but items resolves to empty — no throw
      const flow = makeLoadedFlow({
        name: 'no-overflow',
        inputs: { list: { type: 'array', required: true } },
        steps: [
          {
            id: 'each',
            type: 'loop',
            kind: 'forEach',
            items: 'inputs.list',
            body: [{ id: 'bodystep', type: 'chat', prompt: 'hi', retries: 0 }],
            maxIterations: 1,
            retries: 0,
          },
        ],
      });

      await expect(
        engine.run(flow, { inputs: { list: ['a', 'b', 'c'] } }),
      ).resolves.toBeDefined();
    });
  });

  // ── Loop step (while) ─────────────────────────────────────────────────────

  describe('loop step — while', () => {
    it('never executes body when the condition is initially false', async () => {
      const flow = makeLoadedFlow({
        name: 'while-false',
        steps: [
          {
            id: 'loop',
            type: 'loop',
            kind: 'while',
            expr: 'false',
            body: [{ id: 'body', type: 'chat', prompt: 'never', retries: 0 }],
            maxIterations: 10,
            retries: 0,
          },
        ],
      });

      await engine.run(flow);

      expect(aiMocks.streamText).not.toHaveBeenCalled();
    });
  });

  // ── `when` guard ──────────────────────────────────────────────────────────

  describe('when guard', () => {
    it('skips the step and emits step.skip when the when expression is falsy', async () => {
      const skipEvents: FlowEvent[] = [];

      const flow = makeLoadedFlow({
        name: 'guarded',
        steps: [
          {
            id: 'guarded-step',
            type: 'chat',
            prompt: 'should not run',
            when: 'false',
            retries: 0,
          },
        ],
      });

      await engine.run(flow, {
        onEvent: (e) => { if (e.kind === 'step.skip') skipEvents.push(e); },
      });

      expect(aiMocks.streamText).not.toHaveBeenCalled();
      expect(skipEvents).toHaveLength(1);
      expect(skipEvents[0]?.stepId).toBe('guarded-step');
    });

    it('runs the step when the when expression is truthy', async () => {
      aiMocks.streamText.mockReturnValueOnce({ fullStream: makeFullStream(['ran']) });

      const flow = makeLoadedFlow({
        name: 'guard-true',
        steps: [
          {
            id: 'run-step',
            type: 'chat',
            prompt: 'run',
            when: 'true',
            retries: 0,
          },
        ],
      });

      await engine.run(flow);

      expect(aiMocks.streamText).toHaveBeenCalledOnce();
    });
  });

  // ── Output expressions ────────────────────────────────────────────────────

  describe('output expressions', () => {
    it('resolves declared outputs from step outputs', async () => {
      aiMocks.streamText.mockReturnValueOnce({ fullStream: makeFullStream(['final-answer']) });

      const flow = makeLoadedFlow({
        name: 'with-outputs',
        steps: [{ id: 'answer', type: 'chat', prompt: 'give answer', retries: 0 }],
        outputs: { result: 'steps.answer.output' },
      });

      const result = await engine.run(flow);

      expect(result['result']).toBe('final-answer');
      expect(result['answer']).toBeUndefined(); // only declared outputs returned
    });

    it('returns raw stepOutputs when no outputs map is declared', async () => {
      aiMocks.streamText.mockReturnValueOnce({ fullStream: makeFullStream(['raw']) });

      const result = await engine.run(makeChatFlow('raw prompt'));

      expect(result['greet']).toBe('raw');
    });
  });

  // ── flow.start / flow.done events ─────────────────────────────────────────

  describe('flow lifecycle events', () => {
    it('emits flow.start before any step and flow.done after all steps', async () => {
      aiMocks.streamText.mockReturnValueOnce({ fullStream: makeFullStream(['ok']) });

      const events: FlowEvent[] = [];
      await engine.run(makeChatFlow(), { onEvent: (e) => events.push(e) });

      const kinds = events.map((e) => e.kind);
      expect(kinds[0]).toBe('flow.start');
      expect(kinds[kinds.length - 1]).toBe('flow.done');
    });

    it('emits flow.done with the evaluated outputs map', async () => {
      aiMocks.streamText.mockReturnValueOnce({ fullStream: makeFullStream(['hello world']) });

      const flow = makeLoadedFlow({
        name: 'outputs-map',
        steps: [{ id: 'greet', type: 'chat', prompt: 'hi', retries: 0 }],
        outputs: { answer: 'steps.greet.output' },
      });

      let doneEvent: FlowEvent | undefined;
      await engine.run(flow, {
        onEvent: (e) => { if (e.kind === 'flow.done') doneEvent = e; },
      });

      expect(doneEvent?.outputs?.['answer']).toBe('hello world');
    });

    it('emits flow.error and rethrows on step failure', async () => {
      const boom = new Error('stream died');
      aiMocks.streamText.mockReturnValueOnce({ fullStream: makeFullStream([], boom) });

      const errorEvents: FlowEvent[] = [];
      await expect(
        engine.run(makeChatFlow(), {
          onEvent: (e) => { if (e.kind === 'flow.error') errorEvents.push(e); },
        }),
      ).rejects.toThrow('stream died');

      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]?.error).toBe('stream died');
    });
  });

  // ── Persistence calls ─────────────────────────────────────────────────────

  describe('persistence calls', () => {
    it('calls upsertFlow then createFlowRun before any step runs', async () => {
      aiMocks.streamText.mockReturnValueOnce({ fullStream: makeFullStream(['ok']) });

      await engine.run(makeChatFlow());

      expect(vi.mocked(mockUpsertFlow)).toHaveBeenCalledOnce();
      expect(vi.mocked(mockCreateFlowRun)).toHaveBeenCalledOnce();
    });

    it('calls updateFlowRun with status succeeded on normal completion', async () => {
      aiMocks.streamText.mockReturnValueOnce({ fullStream: makeFullStream(['ok']) });

      await engine.run(makeChatFlow());

      expect(vi.mocked(mockUpdateFlowRun)).toHaveBeenCalledWith(
        'run-id-1',
        expect.objectContaining({ status: 'succeeded' }),
      );
    });

    it('calls updateFlowRun with status failed when a step throws', async () => {
      const boom = new Error('oops');
      aiMocks.streamText.mockReturnValueOnce({ fullStream: makeFullStream([], boom) });

      await expect(engine.run(makeChatFlow())).rejects.toThrow();

      expect(vi.mocked(mockUpdateFlowRun)).toHaveBeenCalledWith(
        'run-id-1',
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it('records endedAt in the updateFlowRun call (regression: was previously omitted)', async () => {
      aiMocks.streamText.mockReturnValueOnce({ fullStream: makeFullStream(['ok']) });

      await engine.run(makeChatFlow());

      const updateCall = vi.mocked(mockUpdateFlowRun).mock.calls[0];
      const updateOpts = updateCall?.[1];
      expect(updateOpts?.endedAt).toBeDefined();
      expect(typeof updateOpts?.endedAt).toBe('string');
    });

    it('calls upsertStepResult with status running then succeeded for a passing step', async () => {
      aiMocks.streamText.mockReturnValueOnce({ fullStream: makeFullStream(['ok']) });

      await engine.run(makeChatFlow());

      const calls = vi.mocked(mockUpsertStepResult).mock.calls;
      const statuses = calls.map((c) => c[0]?.status);
      expect(statuses).toContain('running');
      expect(statuses).toContain('succeeded');
    });

    it('calls updateFlowRun with status cancelled when AbortSignal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      // Even with a pre-aborted signal the flow.run() throws synchronously before
      // any LLM call — updateFlowRun is called with cancelled.
      await expect(
        engine.run(makeChatFlow(), { signal: controller.signal }),
      ).rejects.toThrow('Flow cancelled');

      expect(vi.mocked(mockUpdateFlowRun)).toHaveBeenCalledWith(
        'run-id-1',
        expect.objectContaining({ status: 'cancelled' }),
      );
    });
  });

  // ── AbortSignal — mid-run cancellation ───────────────────────────────────

  describe('AbortSignal cancellation', () => {
    it('stops execution and throws when signal is pre-aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        engine.run(makeChatFlow(), { signal: controller.signal }),
      ).rejects.toThrow('Flow cancelled');

      expect(aiMocks.streamText).not.toHaveBeenCalled();
    });

    it('stops mid-stream when signal is aborted while iterating the fullStream', async () => {
      const controller = new AbortController();

      // Build a stream that aborts the controller mid-flight
      aiMocks.streamText.mockReturnValueOnce({
        fullStream: (async function* () {
          yield { type: 'text-delta', textDelta: 'partial' };
          // Abort now — the next iteration should bail out
          controller.abort();
          yield { type: 'text-delta', textDelta: 'should-not-appear' };
        })(),
      });

      const streamTokens: string[] = [];
      await expect(
        engine.run(makeChatFlow(), {
          signal: controller.signal,
          onEvent: (e) => {
            if (e.kind === 'step.stream' && e.text !== undefined) {
              streamTokens.push(e.text);
            }
          },
        }),
      ).rejects.toThrow('Flow cancelled');

      // 'should-not-appear' must not have been emitted as a step.stream event
      expect(streamTokens).not.toContain('should-not-appear');
    });
  });

  // ── Step timeout ──────────────────────────────────────────────────────────

  describe('step timeout', () => {
    it('rejects the run when a step exceeds its timeoutMs', async () => {
      vi.useFakeTimers();

      // The stream suspends until the abort signal fires. Once the timeout
      // setTimeout fires and aborts the step controller, the generator resumes
      // and throws — which propagates through the for-await in executeChatStep.
      aiMocks.streamText.mockImplementation(
        (({ abortSignal }: { abortSignal?: AbortSignal }) => ({
          fullStream: (async function* () {
            await new Promise<void>((resolve) => {
              if (abortSignal !== undefined) {
                abortSignal.addEventListener('abort', () => resolve(), { once: true });
              }
            });
            throw new Error('Step slowstep timed out after 50ms');
          })(),
        })) as never,
      );

      const flow = makeLoadedFlow({
        name: 'timeout-test',
        steps: [{ id: 'slowstep', type: 'chat', prompt: 'hi', timeoutMs: 50, retries: 0 }],
      });

      // Attach the catch handler BEFORE advancing timers so the rejection is
      // never unhandled during the timer-fire window.
      const runPromise = engine.run(flow);
      const caughtError = runPromise.catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(100);

      const err = await caughtError;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('timed out');
    });
  });

  // ── Retry behaviour ───────────────────────────────────────────────────────
  //
  // Real timers are used here — fake timers + async generators have subtle
  // interaction issues with Vitest's microtask flushing. The back-off delay
  // is overridden to 1ms by patching the sleep utility via a short timeout.

  describe('retry behaviour', () => {
    it('retries up to the configured count and succeeds on a later attempt', async () => {
      vi.useFakeTimers();

      const boom = new Error('transient error');
      let callCount = 0;
      // Fail twice, succeed on the third attempt
      aiMocks.streamText.mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return { fullStream: makeFullStream([], boom) };
        }
        return { fullStream: makeFullStream(['ok']) };
      });

      const flow = makeLoadedFlow({
        name: 'retry-flow',
        steps: [{ id: 'flaky', type: 'chat', prompt: 'go', retries: 2 }],
      });

      const retryEvents: FlowEvent[] = [];
      const runPromise = engine.run(flow, {
        onEvent: (e) => { if (e.kind === 'step.retry') retryEvents.push(e); },
      });
      // Pre-attach catch to prevent unhandled rejection if intermediate errors
      // escape during timer advancement before the final success resolves.
      const settled = runPromise.then((v) => ({ ok: true, value: v })).catch((e: unknown) => ({ ok: false, error: e }));

      // Step through back-off sleep calls
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(600);
      }

      const result = await settled;
      expect(result.ok).toBe(true);
      expect(retryEvents).toHaveLength(2);
    }, 15_000);

    it('emits step.error and throws after exhausting all retries', async () => {
      vi.useFakeTimers();

      const boom = new Error('always fails');
      aiMocks.streamText.mockImplementation(() => ({ fullStream: makeFullStream([], boom) }));

      const flow = makeLoadedFlow({
        name: 'always-fail',
        steps: [{ id: 'broken', type: 'chat', prompt: 'go', retries: 1 }],
      });

      const errorEvents: FlowEvent[] = [];
      const runPromise = engine.run(flow, {
        onEvent: (e) => { if (e.kind === 'step.error') errorEvents.push(e); },
      });
      // Attach the catch handler BEFORE advancing timers so the rejection is
      // never unhandled during the timer-fire window.
      const caughtError = runPromise.catch((e: unknown) => e);

      // Advance past the single back-off (500ms for retries: 1)
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(600);
      }

      const err = await caughtError;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('always fails');
      expect(errorEvents).toHaveLength(1);
    }, 15_000);
  });

  // ── HTTP tool step ────────────────────────────────────────────────────────

  describe('builtin:http tool step', () => {
    beforeEach(() => {
      // Replace global fetch for HTTP tool tests
      vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function makeHttpFlow(url: string, overrides?: Partial<ReturnType<typeof makeTestConfig>['flows']>): { flow: LoadedFlow; engine: FlowEngine } {
      const config = makeTestConfig({
        flows: { ...makeTestConfig().flows, allowHttpStep: true, ...overrides },
      });
      const flowEngine = new FlowEngine(config);
      const flow = makeLoadedFlow({
        name: 'http-flow',
        steps: [{ id: 'req', type: 'tool', tool: 'builtin:http', args: { url }, retries: 0 }],
      });
      return { flow, engine: flowEngine };
    }

    it('throws when allowHttpStep is false', async () => {
      const config = makeTestConfig({ flows: { ...makeTestConfig().flows, allowHttpStep: false } });
      const httpEngine = new FlowEngine(config);
      const flow = makeLoadedFlow({
        name: 'blocked-http',
        steps: [{ id: 'req', type: 'tool', tool: 'builtin:http', args: { url: 'https://example.com' }, retries: 0 }],
      });

      await expect(httpEngine.run(flow)).rejects.toThrow('HTTP tool is disabled');
    });

    it('blocks requests to domains not in httpAllowlist', async () => {
      // The allowlist check compares URL hostname against the pattern
      // (after stripping a leading *. wildcard). Patterns should be
      // plain hostnames like 'api.example.com', not full URLs.
      const { flow, engine: e } = makeHttpFlow('https://evil.com/attack', {
        httpAllowlist: ['api.example.com'],
      });

      await expect(e.run(flow)).rejects.toThrow('not in flows.httpAllowlist');
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it('allows requests to domains in httpAllowlist', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        text: async () => '{"ok":true}',
      } as unknown as Response);

      const { flow, engine: e } = makeHttpFlow('https://api.example.com/data', {
        httpAllowlist: ['api.example.com'],
      });

      const result = await e.run(flow);

      expect(fetch).toHaveBeenCalledOnce();
      expect(result['req']).toEqual({ ok: true });
    });

    /**
     * BUG DOCUMENTATION: When httpAllowlist is empty ([]), the engine skips the
     * allowlist check entirely and allows ALL HTTP requests. This is the opposite
     * of what an empty allowlist should mean (deny all). This test documents the
     * current (buggy) behaviour — it will need to be updated when the bug is fixed.
     *
     * See: the condition in executeBuiltinTool is:
     *   if (this.config.flows.httpAllowlist.length > 0) { ... enforce ... }
     * An empty allowlist bypasses enforcement.
     */
    it('CURRENT BEHAVIOUR: empty httpAllowlist allows all HTTP (bug — should deny all)', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        text: async () => '{"data":"sensitive"}',
      } as unknown as Response);

      const { flow, engine: e } = makeHttpFlow('https://any-domain.com/secret');
      // httpAllowlist defaults to [] in makeTestConfig

      // BUG: this should reject but currently resolves
      const result = await e.run(flow);
      expect(result['req']).toEqual({ data: 'sensitive' });
    });

    it('parses JSON response bodies', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        text: async () => '{"value":42}',
      } as unknown as Response);

      const { flow, engine: e } = makeHttpFlow('https://api.example.com');
      const result = await e.run(flow);

      expect(result['req']).toEqual({ value: 42 });
    });

    it('returns raw text when response is not valid JSON', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        text: async () => 'plain text response',
      } as unknown as Response);

      const { flow, engine: e } = makeHttpFlow('https://api.example.com');
      const result = await e.run(flow);

      expect(result['req']).toBe('plain text response');
    });

    it('throws when args.url is missing', async () => {
      const config = makeTestConfig({ flows: { ...makeTestConfig().flows, allowHttpStep: true } });
      const e = new FlowEngine(config);
      const flow = makeLoadedFlow({
        name: 'no-url',
        steps: [{ id: 'req', type: 'tool', tool: 'builtin:http', args: {}, retries: 0 }],
      });

      await expect(e.run(flow)).rejects.toThrow('requires args.url');
    });
  });

  // ── Tool step — unknown tool ──────────────────────────────────────────────

  describe('tool step — unsupported tool', () => {
    it('throws for non-builtin tool references', async () => {
      const flow = makeLoadedFlow({
        name: 'unsupported-tool',
        steps: [{ id: 't1', type: 'tool', tool: 'mcp:some-server/some-tool', args: {}, retries: 0 }],
      });

      await expect(engine.run(flow)).rejects.toThrow('not supported yet');
    });

    it('throws for unknown builtin tool names', async () => {
      const flow = makeLoadedFlow({
        name: 'unknown-builtin',
        steps: [{ id: 't1', type: 'tool', tool: 'builtin:nonexistent', args: {}, retries: 0 }],
      });

      await expect(engine.run(flow)).rejects.toThrow('Unknown builtin tool');
    });
  });
});
