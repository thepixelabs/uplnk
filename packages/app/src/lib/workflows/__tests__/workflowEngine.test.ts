import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runRelay, type RunRelayOptions } from '../workflowEngine.js';
import type { RelayPlan } from '../planSchema.js';
import type { LanguageModelV1 } from '@ai-sdk/provider';

// ── Module mock ─────────────────────────────────────────────────────────────

vi.mock('ai', () => ({
  streamText: vi.fn(),
}));

import { streamText } from 'ai';
const mockStreamText = vi.mocked(streamText);

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a fake streamText return value that yields `tokens` one by one through
 * `textStream` and then resolves `usage` with fixed counts.
 */
function createMockStreamText(tokens: string[], promptTokens = 10, completionTokens = 20) {
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

/** Minimal stub satisfying LanguageModelV1 for opts types */
function makeModelStub(name: string): LanguageModelV1 {
  return { provider: `https://${name}.example.com`, modelId: name } as unknown as LanguageModelV1;
}

/** Baseline relay plan used across tests */
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
    mcpEnabled: true,
  },
};

function makeOpts(overrides: Partial<RunRelayOptions> = {}): RunRelayOptions {
  return {
    plan: basePlan,
    scoutModel: makeModelStub('scout'),
    anchorModel: makeModelStub('anchor'),
    userInput: 'Write a hello world',
    signal: new AbortController().signal,
    ...overrides,
  };
}

// Silence the prewarm fire-and-forget fetch inside workflowEngine so tests
// don't make real network calls or generate unhandled promise warnings.
const globalAny = global as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  // Stub the global fetch used for anchor prewarm
  globalAny['fetch'] = vi.fn().mockResolvedValue({ ok: true });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runRelay', () => {
  it('complete successful run produces correct event sequence', async () => {
    mockStreamText
      .mockReturnValueOnce(createMockStreamText(['Hello ', 'world'], 5, 8) as unknown as ReturnType<typeof streamText>)
      .mockReturnValueOnce(createMockStreamText(['Final ', 'answer'], 12, 25) as unknown as ReturnType<typeof streamText>);

    const events = [];
    for await (const event of runRelay(makeOpts())) {
      events.push(event);
    }

    const types = events.map((e) => e.type);

    expect(types).toEqual([
      'scout:start',
      'scout:delta',
      'scout:delta',
      'scout:end',
      'anchor:start',
      'anchor:delta',
      'anchor:delta',
      'anchor:end',
    ]);

    // Verify delta payloads
    const scoutDeltas = events.filter((e) => e.type === 'scout:delta');
    expect(scoutDeltas.map((e) => (e as { type: 'scout:delta'; text: string }).text)).toEqual(['Hello ', 'world']);

    const anchorDeltas = events.filter((e) => e.type === 'anchor:delta');
    expect(anchorDeltas.map((e) => (e as { type: 'anchor:delta'; text: string }).text)).toEqual(['Final ', 'answer']);

    // Verify end summaries
    const scoutEnd = events.find((e) => e.type === 'scout:end') as { type: 'scout:end'; fullText: string; usage: { inputTokens: number; outputTokens: number } };
    expect(scoutEnd.fullText).toBe('Hello world');
    expect(scoutEnd.usage).toEqual({ inputTokens: 5, outputTokens: 8 });

    const anchorEnd = events.find((e) => e.type === 'anchor:end') as { type: 'anchor:end'; fullText: string; usage: { inputTokens: number; outputTokens: number } };
    expect(anchorEnd.fullText).toBe('Final answer');
    expect(anchorEnd.usage).toEqual({ inputTokens: 12, outputTokens: 25 });
  });

  it('scout failure yields error with phase=scout and anchor never starts', async () => {
    mockStreamText.mockImplementationOnce(() => {
      throw new Error('Scout model unreachable');
    });

    const events = [];
    for await (const event of runRelay(makeOpts())) {
      events.push(event);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain('scout:start');
    expect(types).toContain('error');
    expect(types).not.toContain('anchor:start');

    const errorEvent = events.find((e) => e.type === 'error') as { type: 'error'; error: { code: string; phase?: string } };
    expect(errorEvent.error.code).toBe('RELAY_SCOUT_FAILED');
    expect(errorEvent.error.phase).toBe('scout');

    // streamText should have been called only once (scout), never for anchor
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it('empty scout output yields error and anchor never starts', async () => {
    // Scout returns empty string tokens
    mockStreamText.mockReturnValueOnce(
      createMockStreamText(['', '  ', '']) as unknown as ReturnType<typeof streamText>,
    );

    const events = [];
    for await (const event of runRelay(makeOpts())) {
      events.push(event);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain('scout:start');
    expect(types).toContain('error');
    expect(types).not.toContain('anchor:start');

    const errorEvent = events.find((e) => e.type === 'error') as { type: 'error'; error: { code: string } };
    expect(errorEvent.error.code).toBe('RELAY_SCOUT_FAILED');

    // streamText called once for scout, never for anchor
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it('abort during scout yields RELAY_ABORTED error', async () => {
    const controller = new AbortController();

    // Make scout yield one token then hang — we abort after the first event
    async function* slowTokens() {
      yield 'token1';
      // Yield control so the consumer can process and abort
      await new Promise<void>((resolve) => setImmediate(resolve));
      // After abort, yielding should not happen but we simulate the loop check
      yield 'token2';
    }

    mockStreamText.mockReturnValueOnce({
      textStream: slowTokens(),
      usage: Promise.resolve({ promptTokens: 0, completionTokens: 0 }),
    } as unknown as ReturnType<typeof streamText>);

    const events = [];
    const generator = runRelay(makeOpts({ signal: controller.signal }));

    for await (const event of generator) {
      events.push(event);
      // Abort right after scout:start so the first delta triggers the abort check
      if (event.type === 'scout:delta') {
        controller.abort();
      }
      if (event.type === 'error') break;
    }

    const errorEvent = events.find((e) => e.type === 'error') as
      | { type: 'error'; error: { code: string } }
      | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.error.code).toBe('RELAY_ABORTED');
    // Anchor should never have started
    expect(events.map((e) => e.type)).not.toContain('anchor:start');
  });

  it('buildAnchorMessages wraps user input and scout output in XML tags', async () => {
    const scoutTokens = ['Scout said: '];
    const anchorTokens = ['ok'];

    mockStreamText
      .mockReturnValueOnce(createMockStreamText(scoutTokens) as unknown as ReturnType<typeof streamText>)
      .mockReturnValueOnce(createMockStreamText(anchorTokens) as unknown as ReturnType<typeof streamText>);

    for await (const _ of runRelay(makeOpts())) {
      // drain
    }

    // The anchor call is the second call to streamText
    expect(mockStreamText).toHaveBeenCalledTimes(2);
    const anchorCallArgs = mockStreamText.mock.calls[1]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };

    const userMessage = anchorCallArgs.messages.find((m) => m.role === 'user');
    expect(userMessage).toBeDefined();
    expect(userMessage?.content).toContain('<user_request>');
    expect(userMessage?.content).toContain('</user_request>');
    expect(userMessage?.content).toContain('<scout_analysis>');
    expect(userMessage?.content).toContain('</scout_analysis>');
    expect(userMessage?.content).toContain('Write a hello world');
    expect(userMessage?.content).toContain('Scout said: ');
  });
});
