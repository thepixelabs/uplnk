/**
 * workflowEngine — abort, error-emission, and token-accounting tests.
 *
 * Complements workflowEngine.test.ts which covers the happy path, scout
 * failure, empty scout output, and abort-during-scout. This file adds:
 *
 *   - Abort during the SCOUT phase stops scout and never starts anchor.
 *     (Asserted from a different angle than the existing test: we verify
 *     the anchor model's streamText is never invoked.)
 *   - Abort during the ANCHOR phase stops anchor mid-stream and emits
 *     RELAY_ABORTED.
 *   - Token usage is accumulated correctly from both scout and anchor on a
 *     full successful run (sum of inputTokens/outputTokens across phases).
 *   - Anchor throwing a non-abort error emits an error event with
 *     phase='anchor' / code=RELAY_ANCHOR_FAILED.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runRelay, type RunRelayOptions, type EngineEvent } from '../workflowEngine.js';
import type { RelayPlan } from '../planSchema.js';
import type { LanguageModelV1 } from '@ai-sdk/provider';

// ─── Module mock ─────────────────────────────────────────────────────────────

vi.mock('ai', () => ({
  streamText: vi.fn(),
}));

import { streamText } from 'ai';
const mockStreamText = vi.mocked(streamText);

// ─── Fixtures ────────────────────────────────────────────────────────────────

function createMockStreamText(
  tokens: string[],
  promptTokens: number,
  completionTokens: number,
) {
  async function* textStreamGen() {
    for (const t of tokens) {
      yield t;
    }
  }
  return {
    textStream: textStreamGen(),
    usage: Promise.resolve({ promptTokens, completionTokens }),
  };
}

function makeModelStub(name: string): LanguageModelV1 {
  return {
    provider: `https://${name}.example.com`,
    modelId: name,
  } as unknown as LanguageModelV1;
}

const basePlan: RelayPlan = {
  version: 1,
  id: 'test-relay',
  name: 'Test Relay',
  scout: {
    providerId: 'scout-provider',
    model: 'llama3.2:3b',
    systemPrompt: 'Scout prompt',
  },
  anchor: {
    providerId: 'anchor-provider',
    model: 'claude-3-5-sonnet',
    systemPrompt: 'Anchor prompt',
    mcpEnabled: false,
  },
};

function makeOpts(overrides: Partial<RunRelayOptions> = {}): RunRelayOptions {
  return {
    plan: basePlan,
    scoutModel: makeModelStub('scout'),
    anchorModel: makeModelStub('anchor'),
    userInput: 'do the thing',
    signal: new AbortController().signal,
    ...overrides,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function collectAll(gen: AsyncGenerator<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

const globalAny = global as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  globalAny['fetch'] = vi.fn().mockResolvedValue({ ok: true });
});

// ─── Abort during scout ─────────────────────────────────────────────────────

describe('runRelay — abort during scout', () => {
  it('emits RELAY_ABORTED and never invokes the anchor model', async () => {
    const controller = new AbortController();

    async function* slowScout() {
      yield 'scout-chunk-1';
      await new Promise<void>((r) => setImmediate(r));
      yield 'scout-chunk-2';
    }

    mockStreamText.mockReturnValueOnce({
      textStream: slowScout(),
      usage: Promise.resolve({ promptTokens: 0, completionTokens: 0 }),
    } as unknown as ReturnType<typeof streamText>);

    const events: EngineEvent[] = [];
    for await (const event of runRelay(makeOpts({ signal: controller.signal }))) {
      events.push(event);
      if (event.type === 'scout:delta') {
        controller.abort();
      }
      if (event.type === 'error') break;
    }

    const types = events.map((e) => e.type);
    expect(types).toContain('error');
    expect(types).not.toContain('anchor:start');

    // streamText was only ever called with the scout model — anchor never ran.
    expect(mockStreamText).toHaveBeenCalledTimes(1);
    const scoutCallModel = (mockStreamText.mock.calls[0]?.[0] as { model: LanguageModelV1 }).model;
    expect(scoutCallModel.modelId).toBe('scout');

    const errorEvent = events.find((e) => e.type === 'error') as
      | { type: 'error'; error: { code: string } }
      | undefined;
    expect(errorEvent?.error.code).toBe('RELAY_ABORTED');
  });
});

// ─── Abort during anchor ────────────────────────────────────────────────────

describe('runRelay — abort during anchor', () => {
  it('stops the anchor stream and emits RELAY_ABORTED', async () => {
    const controller = new AbortController();

    // Scout runs to completion normally.
    mockStreamText.mockReturnValueOnce(
      createMockStreamText(['scout done'], 3, 5) as unknown as ReturnType<typeof streamText>,
    );

    // Anchor yields one token, then yields control so the consumer can abort,
    // then would yield another token (but the aborted check should fire first).
    async function* slowAnchor() {
      yield 'anchor-chunk-1';
      await new Promise<void>((r) => setImmediate(r));
      yield 'anchor-chunk-2';
    }
    mockStreamText.mockReturnValueOnce({
      textStream: slowAnchor(),
      usage: Promise.resolve({ promptTokens: 0, completionTokens: 0 }),
    } as unknown as ReturnType<typeof streamText>);

    const events: EngineEvent[] = [];
    for await (const event of runRelay(makeOpts({ signal: controller.signal }))) {
      events.push(event);
      if (event.type === 'anchor:delta') {
        controller.abort();
      }
      if (event.type === 'error') break;
    }

    const types = events.map((e) => e.type);
    expect(types).toContain('scout:end');
    expect(types).toContain('anchor:start');
    // Anchor never reached :end because abort short-circuited it.
    expect(types).not.toContain('anchor:end');

    const errorEvent = events.find((e) => e.type === 'error') as
      | { type: 'error'; error: { code: string } }
      | undefined;
    expect(errorEvent?.error.code).toBe('RELAY_ABORTED');
  });
});

// ─── Token accumulation on full run ─────────────────────────────────────────

describe('runRelay — token usage accumulation', () => {
  it('reports scout and anchor token usage separately in their :end events', async () => {
    // The engine emits per-phase usage; the caller is responsible for summing.
    // This test pins the two per-phase numbers so a regression that conflates
    // them (or drops one) is caught.
    mockStreamText
      .mockReturnValueOnce(
        createMockStreamText(['s1', 's2'], 7, 11) as unknown as ReturnType<typeof streamText>,
      )
      .mockReturnValueOnce(
        createMockStreamText(['a1', 'a2'], 13, 17) as unknown as ReturnType<typeof streamText>,
      );

    const events = await collectAll(runRelay(makeOpts()));

    const scoutEnd = events.find((e) => e.type === 'scout:end') as
      | { type: 'scout:end'; usage: { inputTokens: number; outputTokens: number } }
      | undefined;
    const anchorEnd = events.find((e) => e.type === 'anchor:end') as
      | { type: 'anchor:end'; usage: { inputTokens: number; outputTokens: number } }
      | undefined;

    expect(scoutEnd?.usage).toEqual({ inputTokens: 7, outputTokens: 11 });
    expect(anchorEnd?.usage).toEqual({ inputTokens: 13, outputTokens: 17 });

    // A downstream consumer summing the two phases should get these totals.
    const totalInput =
      (scoutEnd?.usage.inputTokens ?? 0) + (anchorEnd?.usage.inputTokens ?? 0);
    const totalOutput =
      (scoutEnd?.usage.outputTokens ?? 0) + (anchorEnd?.usage.outputTokens ?? 0);
    expect(totalInput).toBe(20);
    expect(totalOutput).toBe(28);
  });

  it('defaults missing usage counts to 0 (provider returns no usage)', async () => {
    const scoutStream = {
      textStream: (async function* () {
        yield 'scout';
      })(),
      usage: Promise.resolve(undefined),
    };
    const anchorStream = {
      textStream: (async function* () {
        yield 'anchor';
      })(),
      usage: Promise.resolve(undefined),
    };

    mockStreamText
      .mockReturnValueOnce(scoutStream as unknown as ReturnType<typeof streamText>)
      .mockReturnValueOnce(anchorStream as unknown as ReturnType<typeof streamText>);

    const events = await collectAll(runRelay(makeOpts()));

    const scoutEnd = events.find((e) => e.type === 'scout:end') as
      | { type: 'scout:end'; usage: { inputTokens: number; outputTokens: number } }
      | undefined;
    const anchorEnd = events.find((e) => e.type === 'anchor:end') as
      | { type: 'anchor:end'; usage: { inputTokens: number; outputTokens: number } }
      | undefined;

    expect(scoutEnd?.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(anchorEnd?.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

// ─── Anchor throws non-abort error ──────────────────────────────────────────

describe('runRelay — anchor throws a non-abort error', () => {
  it('emits error with code=RELAY_ANCHOR_FAILED and phase=anchor', async () => {
    // Scout succeeds.
    mockStreamText.mockReturnValueOnce(
      createMockStreamText(['scout text'], 2, 3) as unknown as ReturnType<typeof streamText>,
    );

    // Anchor throws synchronously when streamText is invoked.
    mockStreamText.mockImplementationOnce(() => {
      throw new Error('Anchor model unreachable');
    });

    const events = await collectAll(runRelay(makeOpts()));

    const types = events.map((e) => e.type);
    expect(types).toContain('scout:end');
    expect(types).toContain('anchor:start');
    expect(types).toContain('error');
    expect(types).not.toContain('anchor:end');

    const errorEvent = events.find((e) => e.type === 'error') as {
      type: 'error';
      error: { code: string; phase?: string; message: string };
    };
    expect(errorEvent.error.code).toBe('RELAY_ANCHOR_FAILED');
    expect(errorEvent.error.phase).toBe('anchor');
    expect(errorEvent.error.message).toContain('Anchor model unreachable');
  });

  it('emits error when anchor textStream iteration rejects mid-stream', async () => {
    mockStreamText.mockReturnValueOnce(
      createMockStreamText(['scout'], 1, 1) as unknown as ReturnType<typeof streamText>,
    );

    async function* failingAnchor() {
      yield 'partial';
      throw new Error('connection reset');
    }
    mockStreamText.mockReturnValueOnce({
      textStream: failingAnchor(),
      usage: Promise.resolve({ promptTokens: 0, completionTokens: 0 }),
    } as unknown as ReturnType<typeof streamText>);

    const events = await collectAll(runRelay(makeOpts()));

    const errorEvent = events.find((e) => e.type === 'error') as
      | { type: 'error'; error: { code: string; phase?: string } }
      | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.error.code).toBe('RELAY_ANCHOR_FAILED');
    expect(errorEvent?.error.phase).toBe('anchor');
  });
});
