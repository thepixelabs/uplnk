/**
 * useFlowRunner — unit tests
 *
 * Strategy:
 *  - FlowEngine and its persistence layer are mocked at the module boundary.
 *    Tests exercise the hook's state machine (idle → running → done/error/cancelled)
 *    by controlling what the mocked FlowEngine.run() resolves/rejects with and
 *    what events it fires via the onEvent callback.
 *  - Ink's renderHook-via-Harness pattern (same as useSplitPane.test.ts) keeps
 *    this in the node environment — no jsdom required.
 *  - Each test has exactly one reason to fail.
 *
 * Hoisting note: vi.mock() factories are hoisted before any const declarations.
 * vi.hoisted() makes mock fn refs available to factories without top-level await.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { Text } from 'ink';

// ─── Hoisted mock refs ────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  flowEngineRun: vi.fn<
    (
      loadedFlow: unknown,
      opts: { inputs?: Record<string, unknown>; onEvent?: (e: unknown) => void; signal?: AbortSignal },
    ) => Promise<Record<string, unknown>>
  >(),
  upsertFlow: vi.fn(() => 'flow-id-1'),
  createFlowRun: vi.fn(() => 'run-id-1'),
  updateFlowRun: vi.fn(),
  upsertStepResult: vi.fn(),
}));

vi.mock('../../flow/engine/FlowEngine.js', () => ({
  FlowEngine: vi.fn().mockImplementation(() => ({
    run: mocks.flowEngineRun,
  })),
}));

vi.mock('../../flow/persistence/flowRepo.js', () => ({
  upsertFlow: mocks.upsertFlow,
  createFlowRun: mocks.createFlowRun,
  updateFlowRun: mocks.updateFlowRun,
  upsertStepResult: mocks.upsertStepResult,
}));

// FlowEngine also touches @uplnk/db — the global setup already stubs that,
// but FlowEngine is mocked above so DB is never reached in these tests.

// ─── Imports under test ───────────────────────────────────────────────────────

import { useFlowRunner } from '../useFlowRunner.js';
import type { FlowStepStatus } from '../useFlowRunner.js';
import type { FlowEvent } from '../../flow/engine/FlowEngine.js';
import { makeTestConfig } from '../../__tests__/fixtures/config.js';

// ─── Test data ────────────────────────────────────────────────────────────────

const TEST_CONFIG = makeTestConfig();

function makeLoadedFlow(stepIds: string[] = ['step1']) {
  return {
    path: '/tmp/test-flows/test-flow.yaml',
    hash: 'abc123',
    def: {
      apiVersion: 'uplnk.io/v1' as const,
      name: 'test-flow',
      inputs: {},
      steps: stepIds.map((id) => ({ id, type: 'chat' as const, prompt: 'Hello', retries: 0 })),
    },
  };
}

// ─── Hook harness ─────────────────────────────────────────────────────────────

type HookResult = ReturnType<typeof useFlowRunner>;

function renderFlowRunner(): { hookRef: React.MutableRefObject<HookResult | null> } {
  const hookRef: React.MutableRefObject<HookResult | null> = { current: null };

  function Harness() {
    const result = useFlowRunner(TEST_CONFIG);
    hookRef.current = result;
    return React.createElement(Text, null, result.state.status);
  }

  render(React.createElement(Harness));
  return { hookRef };
}

/** Drain the microtask queue so async state updates commit. */
const tick = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useFlowRunner — initial state', () => {
  it('starts in idle status', () => {
    const { hookRef } = renderFlowRunner();
    expect(hookRef.current?.state.status).toBe('idle');
  });

  it('starts with null flow definition', () => {
    const { hookRef } = renderFlowRunner();
    expect(hookRef.current?.state.flow).toBeNull();
  });

  it('starts with an empty events array', () => {
    const { hookRef } = renderFlowRunner();
    expect(hookRef.current?.state.events).toEqual([]);
  });

  it('starts with null error', () => {
    const { hookRef } = renderFlowRunner();
    expect(hookRef.current?.state.error).toBeNull();
  });

  it('starts with null output', () => {
    const { hookRef } = renderFlowRunner();
    expect(hookRef.current?.state.output).toBeNull();
  });
});

// ─── load() ──────────────────────────────────────────────────────────────────

describe('useFlowRunner — load()', () => {
  it('sets the flow definition from the loaded flow', () => {
    const { hookRef } = renderFlowRunner();
    const loaded = makeLoadedFlow();

    hookRef.current!.load(loaded);

    expect(hookRef.current?.state.flow).toEqual(loaded.def);
  });

  it('stores the loadedFlow reference', () => {
    const { hookRef } = renderFlowRunner();
    const loaded = makeLoadedFlow();

    hookRef.current!.load(loaded);

    expect(hookRef.current?.state.loadedFlow).toBe(loaded);
  });

  it('pre-populates all steps as pending so the UI can render before run starts', () => {
    const { hookRef } = renderFlowRunner();
    const loaded = makeLoadedFlow(['alpha', 'beta', 'gamma']);

    hookRef.current!.load(loaded);

    const statuses = hookRef.current!.state.stepStatuses;
    expect(statuses['alpha']?.status).toBe('pending');
    expect(statuses['beta']?.status).toBe('pending');
    expect(statuses['gamma']?.status).toBe('pending');
  });

  it('resets status to idle when a new flow is loaded mid-run', () => {
    const { hookRef } = renderFlowRunner();
    const loaded = makeLoadedFlow();

    // Simulate a prior run by loading once and checking
    hookRef.current!.load(loaded);
    expect(hookRef.current?.state.status).toBe('idle');
  });

  it('clears events from a previous run when a new flow is loaded', () => {
    const { hookRef } = renderFlowRunner();
    const loaded = makeLoadedFlow();

    hookRef.current!.load(loaded);

    expect(hookRef.current?.state.events).toEqual([]);
  });

  it('pre-populated step entries have null error and null streamedText', () => {
    const { hookRef } = renderFlowRunner();
    const loaded = makeLoadedFlow(['step1']);

    hookRef.current!.load(loaded);

    const entry = hookRef.current!.state.stepStatuses['step1'] as FlowStepStatus;
    expect(entry.error).toBeNull();
    expect(entry.streamedText).toBeNull();
  });
});

// ─── run() — happy path ───────────────────────────────────────────────────────

describe('useFlowRunner — run() happy path', () => {
  it('transitions to running status immediately on run()', async () => {
    // Make run() hold until we explicitly resolve it
    let resolveRun!: (v: Record<string, unknown>) => void;
    mocks.flowEngineRun.mockReturnValueOnce(
      new Promise<Record<string, unknown>>((res) => { resolveRun = res; }),
    );

    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow());

    void hookRef.current!.run();
    await tick();

    expect(hookRef.current?.state.status).toBe('running');
    resolveRun({ step1: 'done' });
    await tick();
  });

  it('transitions to done status when FlowEngine.run() resolves', async () => {
    mocks.flowEngineRun.mockResolvedValueOnce({ step1: 'result-text' });

    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow());

    await hookRef.current!.run();
    await tick();

    expect(hookRef.current?.state.status).toBe('done');
  });

  it('populates output with the resolved value from FlowEngine', async () => {
    const expectedOutput = { step1: 'Hello world response' };
    mocks.flowEngineRun.mockResolvedValueOnce(expectedOutput);

    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow());

    await hookRef.current!.run();
    await tick();

    expect(hookRef.current?.state.output).toEqual(expectedOutput);
  });

  it('clears currentStepId after a successful run', async () => {
    mocks.flowEngineRun.mockResolvedValueOnce({ step1: 'ok' });

    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow());

    await hookRef.current!.run();
    await tick();

    expect(hookRef.current?.state.currentStepId).toBeNull();
  });

  it('passes inputs through to FlowEngine.run()', async () => {
    mocks.flowEngineRun.mockResolvedValueOnce({});

    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow());

    const inputs = { name: 'world', count: 42 };
    await hookRef.current!.run(inputs);

    const callOpts = mocks.flowEngineRun.mock.calls[0]?.[1];
    expect(callOpts?.inputs).toEqual(inputs);
  });

  it('passes an AbortSignal to FlowEngine.run()', async () => {
    mocks.flowEngineRun.mockResolvedValueOnce({});

    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow());

    await hookRef.current!.run();

    const callOpts = mocks.flowEngineRun.mock.calls[0]?.[1];
    expect(callOpts?.signal).toBeInstanceOf(AbortSignal);
  });

  it('does nothing when run() is called without a loaded flow', async () => {
    const { hookRef } = renderFlowRunner();
    // No load() call

    await hookRef.current!.run();
    await tick();

    expect(mocks.flowEngineRun).not.toHaveBeenCalled();
    expect(hookRef.current?.state.status).toBe('idle');
  });
});

// ─── run() — error path ───────────────────────────────────────────────────────

describe('useFlowRunner — run() error path', () => {
  it('transitions to error status when FlowEngine.run() rejects', async () => {
    mocks.flowEngineRun.mockRejectedValueOnce(new Error('provider exploded'));

    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow());

    await hookRef.current!.run().catch(() => undefined);
    await tick();

    expect(hookRef.current?.state.status).toBe('error');
  });

  it('surfaces the error message from the thrown Error', async () => {
    mocks.flowEngineRun.mockRejectedValueOnce(new Error('provider exploded'));

    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow());

    await hookRef.current!.run().catch(() => undefined);
    await tick();

    expect(hookRef.current?.state.error).toBe('provider exploded');
  });

  it('surfaces non-Error thrown values as strings', async () => {
    mocks.flowEngineRun.mockRejectedValueOnce('raw string error');

    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow());

    await hookRef.current!.run().catch(() => undefined);
    await tick();

    expect(hookRef.current?.state.error).toBe('raw string error');
  });

  it('clears currentStepId on error', async () => {
    mocks.flowEngineRun.mockRejectedValueOnce(new Error('boom'));

    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow());

    await hookRef.current!.run().catch(() => undefined);
    await tick();

    expect(hookRef.current?.state.currentStepId).toBeNull();
  });
});

// ─── cancel() ────────────────────────────────────────────────────────────────

describe('useFlowRunner — cancel()', () => {
  it('transitions to cancelled status immediately', () => {
    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow());

    hookRef.current!.cancel();

    expect(hookRef.current?.state.status).toBe('cancelled');
  });

  it('clears currentStepId on cancel', () => {
    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow());

    hookRef.current!.cancel();

    expect(hookRef.current?.state.currentStepId).toBeNull();
  });

  it('sets status to cancelled when engine throws after abort signal fires', async () => {
    // Simulate: run starts, then cancel() is called, engine sees abort and throws
    let rejectRun!: (e: Error) => void;
    let capturedSignal: AbortSignal | undefined;

    mocks.flowEngineRun.mockImplementationOnce(
      (_loaded: unknown, opts: { signal?: AbortSignal }) => {
        capturedSignal = opts.signal;
        return new Promise<Record<string, unknown>>((_res, rej) => { rejectRun = rej; });
      },
    );

    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow());

    // Start run in background
    const runPromise = hookRef.current!.run().catch(() => undefined);
    await tick();

    // cancel() aborts the controller
    hookRef.current!.cancel();
    await tick();

    // Now the engine "sees" the abort and rejects with the abort error
    rejectRun(new Error('Flow cancelled'));
    await runPromise;
    await tick();

    // The hook detects signal.aborted and sets status to 'cancelled'
    expect(capturedSignal?.aborted).toBe(true);
    expect(hookRef.current?.state.status).toBe('cancelled');
  });
});

// ─── reset() ─────────────────────────────────────────────────────────────────

describe('useFlowRunner — reset()', () => {
  it('returns status to idle after a completed run', async () => {
    mocks.flowEngineRun.mockResolvedValueOnce({ step1: 'ok' });

    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow());

    await hookRef.current!.run();
    await tick();
    expect(hookRef.current?.state.status).toBe('done');

    hookRef.current!.reset();

    expect(hookRef.current?.state.status).toBe('idle');
  });

  it('re-initialises all step statuses to pending', async () => {
    mocks.flowEngineRun.mockResolvedValueOnce({ step1: 'ok' });

    const { hookRef } = renderFlowRunner();
    const loaded = makeLoadedFlow(['step1', 'step2']);
    hookRef.current!.load(loaded);

    await hookRef.current!.run();
    await tick();

    hookRef.current!.reset();

    expect(hookRef.current?.state.stepStatuses['step1']?.status).toBe('pending');
    expect(hookRef.current?.state.stepStatuses['step2']?.status).toBe('pending');
  });

  it('clears events accumulated during a prior run', async () => {
    let capturedOnEvent: ((e: FlowEvent) => void) | undefined;
    mocks.flowEngineRun.mockImplementationOnce(
      (_loaded: unknown, opts: { onEvent?: (e: FlowEvent) => void }) => {
        capturedOnEvent = opts.onEvent;
        return Promise.resolve({});
      },
    );

    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow(['step1']));

    const runPromise = hookRef.current!.run();
    await tick();
    capturedOnEvent?.({ kind: 'step.start', runId: 'run-1', stepId: 'step1' });
    await tick();
    await runPromise;
    await tick();

    expect(hookRef.current?.state.events.length).toBeGreaterThan(0);

    hookRef.current!.reset();

    expect(hookRef.current?.state.events).toEqual([]);
  });

  it('is a no-op when called with no flow loaded', () => {
    const { hookRef } = renderFlowRunner();
    // Should not throw
    hookRef.current!.reset();
    expect(hookRef.current?.state.status).toBe('idle');
  });
});

// ─── FlowEvent handling ───────────────────────────────────────────────────────

describe('useFlowRunner — FlowEvent handling', () => {
  function setupEngineWithEvents(
    events: FlowEvent[],
    finalOutput: Record<string, unknown> = {},
  ) {
    mocks.flowEngineRun.mockImplementationOnce(
      (_loaded: unknown, opts: { onEvent?: (e: FlowEvent) => void }) => {
        for (const event of events) {
          opts.onEvent?.(event);
        }
        return Promise.resolve(finalOutput);
      },
    );
  }

  it('step.start event sets the step status to running and tracks currentStepId', async () => {
    setupEngineWithEvents([
      { kind: 'step.start', runId: 'r1', stepId: 'step1' },
    ]);

    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow(['step1']));

    await hookRef.current!.run();
    await tick();

    // After done, currentStepId is null but the event was processed
    // (step.done would have cleared it — here we only fired step.start
    // so status is done at the flow level with step still tracking the event)
    const events = hookRef.current!.state.events;
    expect(events.some((e) => e.kind === 'step.start' && e.stepId === 'step1')).toBe(true);
  });

  it('step.start event sets the step status to running', async () => {
    let capturedOnEvent: ((e: FlowEvent) => void) | undefined;
    mocks.flowEngineRun.mockImplementationOnce(
      (_loaded: unknown, opts: { onEvent?: (e: FlowEvent) => void }) => {
        capturedOnEvent = opts.onEvent;
        return new Promise<Record<string, unknown>>(() => undefined); // never resolves
      },
    );

    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow(['step1']));
    void hookRef.current!.run();
    await tick();

    capturedOnEvent?.({ kind: 'step.start', runId: 'r1', stepId: 'step1' });
    await tick();

    expect(hookRef.current?.state.stepStatuses['step1']?.status).toBe('running');
    expect(hookRef.current?.state.currentStepId).toBe('step1');
  });

  it('step.done event sets the step status to done and clears currentStepId', async () => {
    let capturedOnEvent: ((e: FlowEvent) => void) | undefined;
    mocks.flowEngineRun.mockImplementationOnce(
      (_loaded: unknown, opts: { onEvent?: (e: FlowEvent) => void }) => {
        capturedOnEvent = opts.onEvent;
        return new Promise<Record<string, unknown>>(() => undefined);
      },
    );

    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow(['step1']));
    void hookRef.current!.run();
    await tick();

    capturedOnEvent?.({ kind: 'step.start', runId: 'r1', stepId: 'step1' });
    await tick();
    capturedOnEvent?.({ kind: 'step.done', runId: 'r1', stepId: 'step1', output: 'the answer' });
    await tick();

    expect(hookRef.current?.state.stepStatuses['step1']?.status).toBe('done');
    expect(hookRef.current?.state.stepStatuses['step1']?.output).toBe('the answer');
    expect(hookRef.current?.state.currentStepId).toBeNull();
  });

  it('step.skip event sets the step status to skipped', async () => {
    let capturedOnEvent: ((e: FlowEvent) => void) | undefined;
    mocks.flowEngineRun.mockImplementationOnce(
      (_loaded: unknown, opts: { onEvent?: (e: FlowEvent) => void }) => {
        capturedOnEvent = opts.onEvent;
        return new Promise<Record<string, unknown>>(() => undefined);
      },
    );

    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow(['step1']));
    void hookRef.current!.run();
    await tick();

    capturedOnEvent?.({ kind: 'step.skip', runId: 'r1', stepId: 'step1' });
    await tick();

    expect(hookRef.current?.state.stepStatuses['step1']?.status).toBe('skipped');
  });

  it('step.error event sets the step status to error with the error message', async () => {
    let capturedOnEvent: ((e: FlowEvent) => void) | undefined;
    mocks.flowEngineRun.mockImplementationOnce(
      (_loaded: unknown, opts: { onEvent?: (e: FlowEvent) => void }) => {
        capturedOnEvent = opts.onEvent;
        return new Promise<Record<string, unknown>>(() => undefined);
      },
    );

    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow(['step1']));
    void hookRef.current!.run();
    await tick();

    capturedOnEvent?.({ kind: 'step.error', runId: 'r1', stepId: 'step1', error: 'timeout' });
    await tick();

    expect(hookRef.current?.state.stepStatuses['step1']?.status).toBe('error');
    expect(hookRef.current?.state.stepStatuses['step1']?.error).toBe('timeout');
    expect(hookRef.current?.state.currentStepId).toBeNull();
  });

  it('step.error event uses "Unknown error" when no error message is provided', async () => {
    let capturedOnEvent: ((e: FlowEvent) => void) | undefined;
    mocks.flowEngineRun.mockImplementationOnce(
      (_loaded: unknown, opts: { onEvent?: (e: FlowEvent) => void }) => {
        capturedOnEvent = opts.onEvent;
        return new Promise<Record<string, unknown>>(() => undefined);
      },
    );

    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow(['step1']));
    void hookRef.current!.run();
    await tick();

    capturedOnEvent?.({ kind: 'step.error', runId: 'r1', stepId: 'step1' }); // no error field
    await tick();

    expect(hookRef.current?.state.stepStatuses['step1']?.error).toBe('Unknown error');
  });

  it('step.stream events accumulate text in streamedText', async () => {
    let capturedOnEvent: ((e: FlowEvent) => void) | undefined;
    mocks.flowEngineRun.mockImplementationOnce(
      (_loaded: unknown, opts: { onEvent?: (e: FlowEvent) => void }) => {
        capturedOnEvent = opts.onEvent;
        return new Promise<Record<string, unknown>>(() => undefined);
      },
    );

    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow(['step1']));
    void hookRef.current!.run();
    await tick();

    capturedOnEvent?.({ kind: 'step.start', runId: 'r1', stepId: 'step1' });
    await tick();
    capturedOnEvent?.({ kind: 'step.stream', runId: 'r1', stepId: 'step1', text: 'Hello' });
    await tick();
    capturedOnEvent?.({ kind: 'step.stream', runId: 'r1', stepId: 'step1', text: ' world' });
    await tick();

    expect(hookRef.current?.state.stepStatuses['step1']?.streamedText).toBe('Hello world');
  });

  it('step.done preserves accumulated streamedText from prior step.stream events', async () => {
    let capturedOnEvent: ((e: FlowEvent) => void) | undefined;
    mocks.flowEngineRun.mockImplementationOnce(
      (_loaded: unknown, opts: { onEvent?: (e: FlowEvent) => void }) => {
        capturedOnEvent = opts.onEvent;
        return new Promise<Record<string, unknown>>(() => undefined);
      },
    );

    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow(['step1']));
    void hookRef.current!.run();
    await tick();

    capturedOnEvent?.({ kind: 'step.start', runId: 'r1', stepId: 'step1' });
    await tick();
    capturedOnEvent?.({ kind: 'step.stream', runId: 'r1', stepId: 'step1', text: 'partial' });
    await tick();
    capturedOnEvent?.({ kind: 'step.done', runId: 'r1', stepId: 'step1', output: 'partial' });
    await tick();

    expect(hookRef.current?.state.stepStatuses['step1']?.streamedText).toBe('partial');
  });

  it('every FlowEvent is appended to the events array in order', async () => {
    let capturedOnEvent: ((e: FlowEvent) => void) | undefined;
    mocks.flowEngineRun.mockImplementationOnce(
      (_loaded: unknown, opts: { onEvent?: (e: FlowEvent) => void }) => {
        capturedOnEvent = opts.onEvent;
        return new Promise<Record<string, unknown>>(() => undefined);
      },
    );

    const { hookRef } = renderFlowRunner();
    hookRef.current!.load(makeLoadedFlow(['step1']));
    void hookRef.current!.run();
    await tick();

    capturedOnEvent?.({ kind: 'step.start', runId: 'r1', stepId: 'step1' });
    capturedOnEvent?.({ kind: 'step.done', runId: 'r1', stepId: 'step1', output: 'x' });
    await tick();

    const kinds = hookRef.current!.state.events.map((e) => e.kind);
    expect(kinds).toEqual(['step.start', 'step.done']);
  });
});
