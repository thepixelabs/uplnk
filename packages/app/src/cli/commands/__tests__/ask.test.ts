/**
 * ask.test.ts
 *
 * Unit tests for runAsk().  The AI SDK (streamText), the language model
 * factory, config, and the DB are all mocked at their module boundaries so
 * only the logic in ask.ts is exercised.
 *
 * IMPORTANT: process.exit() in Node never actually stops execution in tests
 * unless we make it throw.  The spyOnProcess helper prevents real exit, but
 * code after the `process.exit(1)` call in the source continues running.
 * We therefore install a throwing spy — any call to process.exit() during an
 * "error path" test throws ProcessExitError, which we catch so the test does
 * not explode while still being able to assert on the captured output/code.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spyOnProcess } from '../../../__tests__/helpers/processSpy.js';
import { makeFakeProviderRow } from '../../../__tests__/helpers/fakeProviderRow.js';
import { createStreamTextMock } from '../../../__tests__/helpers/streamTextMock.js';

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

vi.mock('ai', () => ({
  streamText: vi.fn(),
}));

vi.mock('../../../lib/languageModelFactory.js', () => ({
  createLanguageModel: vi.fn(() => ({ provider: 'mock', modelId: 'mock-model' })),
}));

vi.mock('../../../lib/secrets.js', () => ({
  resolveSecret: vi.fn((v: unknown) => (typeof v === 'string' ? v : null)),
}));

vi.mock('../../../lib/errors.js', () => ({
  toUplnkError: vi.fn((err: unknown) => ({
    message: err instanceof Error ? err.message : String(err),
    code: 'UNKNOWN',
  })),
}));

vi.mock('../../../lib/config.js', () => ({
  getOrCreateConfig: vi.fn(() => ({
    ok: true,
    config: {
      headless: { defaultProvider: undefined, defaultModel: undefined, persist: false },
      flows: { dir: '~/.uplnk/flows' },
    },
  })),
}));

// ── Static imports (after mocks) ──────────────────────────────────────────────

import { streamText } from 'ai';
import { getOrCreateConfig } from '../../../lib/config.js';
import { getDefaultProvider, getProviderById, createConversation, insertMessage } from '@uplnk/db';
import { runAsk } from '../ask.js';

const mockStreamText = vi.mocked(streamText);
const mockGetOrCreateConfig = vi.mocked(getOrCreateConfig);
const mockGetDefaultProvider = vi.mocked(getDefaultProvider);
const mockGetProviderById = vi.mocked(getProviderById);
const mockCreateConversation = vi.mocked(createConversation);
const mockInsertMessage = vi.mocked(insertMessage);

// ── Sentinel error class ──────────────────────────────────────────────────────

class ProcessExitError extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
    this.name = 'ProcessExitError';
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROVIDER_ROW = makeFakeProviderRow({
  id: 'ollama-local',
  providerType: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  apiKey: 'ollama',
  defaultModel: 'qwen2.5:7b',
});

const DEFAULT_CONFIG = {
  ok: true as const,
  config: {
    headless: { defaultProvider: undefined, defaultModel: undefined, persist: false },
    flows: { dir: '~/.uplnk/flows' },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDefaultProvider.mockReturnValue(PROVIDER_ROW);
  mockGetProviderById.mockReturnValue(PROVIDER_ROW);
  mockGetOrCreateConfig.mockReturnValue(DEFAULT_CONFIG as ReturnType<typeof getOrCreateConfig>);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runAsk — plain format (default)', () => {
  it('streams text deltas to stdout', async () => {
    mockStreamText.mockReturnValueOnce(
      createStreamTextMock(['Hello', ', world']) as unknown as ReturnType<typeof streamText>,
    );

    const spy = spyOnProcess();
    await runAsk({ prompt: 'hi', format: 'plain', quiet: true });
    const out = spy.getStdout();
    spy.restore();

    expect(out).toContain('Hello');
    expect(out).toContain(', world');
  });

  it('does not call process.exit on success', async () => {
    mockStreamText.mockReturnValueOnce(
      createStreamTextMock(['ok']) as unknown as ReturnType<typeof streamText>,
    );

    const spy = spyOnProcess();
    await runAsk({ prompt: 'hi', format: 'plain', quiet: true });
    spy.restore();

    expect(spy.exit).not.toHaveBeenCalledWith(1);
  });
});

describe('runAsk — json format', () => {
  it('outputs a single JSON object containing text and usage', async () => {
    mockStreamText.mockReturnValueOnce(
      createStreamTextMock(['answer'], { usage: { promptTokens: 3, completionTokens: 7 } }) as unknown as ReturnType<typeof streamText>,
    );

    const spy = spyOnProcess();
    await runAsk({ prompt: 'q', format: 'json', quiet: true });
    const out = spy.getStdout();
    spy.restore();

    const parsed = JSON.parse(out) as { text: string; usage: { inputTokens: number; outputTokens: number } };
    expect(parsed.text).toBe('answer');
    expect(parsed.usage.inputTokens).toBe(3);
    expect(parsed.usage.outputTokens).toBe(7);
  });
});

describe('runAsk — ndjson format', () => {
  it('emits delta events followed by a done event', async () => {
    mockStreamText.mockReturnValueOnce(
      createStreamTextMock(['chunk1', 'chunk2']) as unknown as ReturnType<typeof streamText>,
    );

    const spy = spyOnProcess();
    await runAsk({ prompt: 'q', format: 'ndjson', quiet: true });
    const lines = spy.getStdout().trim().split('\n');
    spy.restore();

    expect(lines.length).toBeGreaterThanOrEqual(3);

    const events = lines.map((l) => JSON.parse(l) as { type: string });
    const types = events.map((e) => e.type);
    expect(types).toContain('delta');
    expect(types).toContain('done');
    expect(types.at(-1)).toBe('done');
  });
});

describe('runAsk — provider resolution', () => {
  it('exits nonzero with a helpful message when no provider is configured', async () => {
    mockGetDefaultProvider.mockReturnValueOnce(undefined as unknown as ReturnType<typeof getDefaultProvider>);

    const spy = spyOnProcess();
    spy.exit.mockImplementationOnce((code) => { throw new ProcessExitError(code as number); });

    let caught: ProcessExitError | undefined;
    try {
      await runAsk({ prompt: 'hi' });
    } catch (e) {
      if (e instanceof ProcessExitError) caught = e;
      else throw e;
    }
    const stderr = spy.getStderr();
    spy.restore();

    expect(caught?.code).toBe(1);
    expect(stderr).toContain('no provider configured');
  });

  it('uses getProviderById when --provider flag is passed', async () => {
    mockStreamText.mockReturnValueOnce(
      createStreamTextMock(['ok']) as unknown as ReturnType<typeof streamText>,
    );

    const spy = spyOnProcess();
    await runAsk({ prompt: 'hi', provider: 'ollama-local', quiet: true });
    spy.restore();

    expect(mockGetProviderById).toHaveBeenCalledWith(expect.anything(), 'ollama-local');
  });

  it('exits nonzero with a message when the specified provider id does not exist', async () => {
    mockGetProviderById.mockReturnValueOnce(undefined as unknown as ReturnType<typeof getProviderById>);

    const spy = spyOnProcess();
    spy.exit.mockImplementationOnce((code) => { throw new ProcessExitError(code as number); });

    let caught: ProcessExitError | undefined;
    try {
      await runAsk({ prompt: 'hi', provider: 'nonexistent' });
    } catch (e) {
      if (e instanceof ProcessExitError) caught = e;
      else throw e;
    }
    const stderr = spy.getStderr();
    spy.restore();

    expect(caught?.code).toBe(1);
    expect(stderr).toContain('no provider configured');
  });
});

describe('runAsk — config error', () => {
  it('exits nonzero when config validation fails', async () => {
    mockGetOrCreateConfig.mockReturnValueOnce({
      ok: false,
      error: 'version: Invalid literal value',
    } as unknown as ReturnType<typeof getOrCreateConfig>);

    const spy = spyOnProcess();
    spy.exit.mockImplementationOnce((code) => { throw new ProcessExitError(code as number); });

    let caught: ProcessExitError | undefined;
    try {
      await runAsk({ prompt: 'hi' });
    } catch (e) {
      if (e instanceof ProcessExitError) caught = e;
      else throw e;
    }
    const stderr = spy.getStderr();
    spy.restore();

    expect(caught?.code).toBe(1);
    expect(stderr).toContain('config error');
  });
});

describe('runAsk — EPIPE handling', () => {
  it('exits cleanly (no exit code 1) when stdout emits an EPIPE error', async () => {
    // The stream yields one token then simulates an EPIPE.
    // The AbortController in ask.ts will fire and the catch block
    // recognises the abort and exits cleanly.
    mockStreamText.mockImplementationOnce((_opts: unknown) => {
      async function* brokenStream() {
        // Give runAsk a tick to attach the stdout error listener.
        await new Promise<void>((r) => process.nextTick(r));
        // Emit EPIPE — ask.ts listens for this and calls controller.abort()
        process.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        // The AbortError will be thrown when the for-await loop resumes
        yield { type: 'text-delta' as const, textDelta: 'hello' };
        yield { type: 'finish' as const, usage: { promptTokens: 0, completionTokens: 0 }, finishReason: 'stop' };
      }
      return { fullStream: brokenStream() };
    });

    const spy = spyOnProcess();
    await runAsk({ prompt: 'test', format: 'plain', quiet: true });
    spy.restore();

    // The EPIPE path sets exitCode = 0 and returns — it must NOT call exit(1)
    expect(spy.exit).not.toHaveBeenCalledWith(1);
  });
});

describe('runAsk — stream error event', () => {
  it('exits with code 1 when the fullStream emits an error event', async () => {
    mockStreamText.mockImplementationOnce((_opts: unknown) => {
      async function* errorStream() {
        yield { type: 'error' as const, error: new Error('model overloaded') };
      }
      return { fullStream: errorStream() };
    });

    const spy = spyOnProcess();
    spy.exit.mockImplementation((code) => { throw new ProcessExitError(code as number); });

    let caught: ProcessExitError | undefined;
    try {
      await runAsk({ prompt: 'hi', format: 'plain', quiet: true });
    } catch (e) {
      if (e instanceof ProcessExitError) caught = e;
      else throw e;
    }
    spy.restore();

    expect(caught?.code).toBe(1);
  });
});

describe('runAsk — persistence', () => {
  it('calls createConversation and insertMessage twice when persist:true', async () => {
    mockGetOrCreateConfig.mockReturnValueOnce({
      ok: true,
      config: {
        headless: { defaultProvider: undefined, defaultModel: undefined, persist: true },
        flows: { dir: '~/.uplnk/flows' },
      },
    } as unknown as ReturnType<typeof getOrCreateConfig>);

    mockStreamText.mockReturnValueOnce(
      createStreamTextMock(['persisted response']) as unknown as ReturnType<typeof streamText>,
    );

    const spy = spyOnProcess();
    await runAsk({ prompt: 'remember this', format: 'plain', quiet: true });
    spy.restore();

    expect(mockCreateConversation).toHaveBeenCalledOnce();
    expect(mockInsertMessage).toHaveBeenCalledTimes(2);
  });

  it('does NOT call createConversation when persist:false', async () => {
    mockStreamText.mockReturnValueOnce(
      createStreamTextMock(['ephemeral']) as unknown as ReturnType<typeof streamText>,
    );

    const spy = spyOnProcess();
    await runAsk({ prompt: 'hi', format: 'plain', quiet: true });
    spy.restore();

    expect(mockCreateConversation).not.toHaveBeenCalled();
  });
});
