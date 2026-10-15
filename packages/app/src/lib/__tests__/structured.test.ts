/**
 * structured.ts — unit tests for generateStructured.
 *
 * `generateObject` / `generateText` are mocked at the 'ai' module boundary
 * (same pattern as the deepResearch suites); everything else — the retry
 * loop, corrective messages, parseLlmJson fallback, and error shaping — runs
 * for real. NoObjectGeneratedError instances are constructed from the REAL
 * class (via importOriginal) so `NoObjectGeneratedError.isInstance` matches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

const aiMocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  generateText: vi.fn(),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateObject: (...args: unknown[]) => aiMocks.generateObject(...args),
    generateText: (...args: unknown[]) => aiMocks.generateText(...args),
  };
});

import { NoObjectGeneratedError } from 'ai';
import type { CoreMessage, LanguageModel } from 'ai';
import { isUplnkError } from '@uplnk/shared';
import { generateStructured, StructuredOutputError } from '../structured.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FAKE_MODEL = {} as LanguageModel;

const CountSchema = z.object({ count: z.number() });

const USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

function makeValidationError(text: string, reason = 'response did not match schema'): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message: 'No object generated: response did not match schema.',
    cause: new Error(reason),
    text,
    response: { id: 'resp-1', timestamp: new Date(), modelId: 'fake' },
    usage: USAGE,
    finishReason: 'stop',
  });
}

interface CapturedCall {
  messages: CoreMessage[];
  mode?: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
}

function lastObjectCall(n = 0): CapturedCall {
  const calls = aiMocks.generateObject.mock.calls;
  return calls[n]![0] as CapturedCall;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('generateStructured — primary path', () => {
  it('returns the validated object on the first try', async () => {
    aiMocks.generateObject.mockResolvedValueOnce({ object: { count: 3 }, usage: USAGE });

    const result = await generateStructured({
      model: FAKE_MODEL,
      schema: CountSchema,
      prompt: 'count the things',
    });

    expect(result.object).toEqual({ count: 3 });
    expect(result.usage).toEqual(USAGE);
    expect(aiMocks.generateObject).toHaveBeenCalledOnce();
    expect(aiMocks.generateText).not.toHaveBeenCalled();
  });

  it('uses JSON mode (not tool mode) and converts prompt to a user message', async () => {
    aiMocks.generateObject.mockResolvedValueOnce({ object: { count: 1 }, usage: USAGE });

    await generateStructured({
      model: FAKE_MODEL,
      schema: CountSchema,
      prompt: 'count',
      system: 'You count things.',
      temperature: 0.2,
    });

    const call = lastObjectCall();
    expect(call.mode).toBe('json');
    expect(call.system).toBe('You count things.');
    expect(call.temperature).toBe(0.2);
    expect(call.messages).toEqual([{ role: 'user', content: 'count' }]);
  });

  it('throws when neither prompt nor messages is provided', async () => {
    await expect(
      generateStructured({ model: FAKE_MODEL, schema: CountSchema }),
    ).rejects.toThrow('requires either `prompt` or a non-empty `messages`');
    expect(aiMocks.generateObject).not.toHaveBeenCalled();
  });
});

describe('generateStructured — corrective retry', () => {
  it('retries with a corrective user message quoting the invalid output and validation error', async () => {
    aiMocks.generateObject
      .mockRejectedValueOnce(makeValidationError('{"count": "three"}', 'Expected number, received string'))
      .mockResolvedValueOnce({ object: { count: 3 }, usage: USAGE });

    const result = await generateStructured({
      model: FAKE_MODEL,
      schema: CountSchema,
      prompt: 'count',
    });

    expect(result.object).toEqual({ count: 3 });
    expect(aiMocks.generateObject).toHaveBeenCalledTimes(2);

    // The retry call carries the original prompt PLUS the corrective message.
    const retryCall = lastObjectCall(1);
    expect(retryCall.messages).toHaveLength(2);
    const corrective = retryCall.messages[1]!;
    expect(corrective.role).toBe('user');
    expect(corrective.content).toContain('{"count": "three"}');
    expect(corrective.content).toContain('Expected number, received string');
    expect(corrective.content).toContain('ONLY a corrected JSON object');
  });

  it('accumulates usage across failed and successful attempts', async () => {
    aiMocks.generateObject
      .mockRejectedValueOnce(makeValidationError('nope'))
      .mockResolvedValueOnce({ object: { count: 2 }, usage: USAGE });

    const result = await generateStructured({
      model: FAKE_MODEL,
      schema: CountSchema,
      prompt: 'count',
    });

    // One failed attempt (USAGE via the error) + one success (USAGE).
    expect(result.usage).toEqual({ promptTokens: 20, completionTokens: 10, totalTokens: 30 });
  });

  it('respects maxRetries before falling back', async () => {
    aiMocks.generateObject.mockRejectedValue(makeValidationError('bad'));
    aiMocks.generateText.mockResolvedValueOnce({ text: '{"count": 7}', usage: USAGE });

    const result = await generateStructured({
      model: FAKE_MODEL,
      schema: CountSchema,
      prompt: 'count',
      maxRetries: 1,
    });

    // maxRetries: 1 → 2 generateObject attempts, then the fallback.
    expect(aiMocks.generateObject).toHaveBeenCalledTimes(2);
    expect(result.object).toEqual({ count: 7 });
  });
});

describe('generateStructured — fallback path', () => {
  it('falls back to generateText + parseLlmJson + safeParse after exhausting retries', async () => {
    aiMocks.generateObject.mockRejectedValue(makeValidationError('still bad'));
    // Fenced + chatty output — exactly what parseLlmJson exists to clean up.
    aiMocks.generateText.mockResolvedValueOnce({
      text: 'Sure! Here you go:\n```json\n{"count": 42}\n```',
      usage: USAGE,
    });

    const result = await generateStructured({
      model: FAKE_MODEL,
      schema: CountSchema,
      prompt: 'count',
    });

    // Default maxRetries 2 → 3 structured attempts, then one text call.
    expect(aiMocks.generateObject).toHaveBeenCalledTimes(3);
    expect(aiMocks.generateText).toHaveBeenCalledOnce();
    expect(result.object).toEqual({ count: 42 });
  });

  it('falls back immediately (no corrective retries) on a non-validation error', async () => {
    aiMocks.generateObject.mockRejectedValueOnce(
      new Error('json mode is not supported by this endpoint'),
    );
    aiMocks.generateText.mockResolvedValueOnce({ text: '{"count": 5}', usage: USAGE });

    const result = await generateStructured({
      model: FAKE_MODEL,
      schema: CountSchema,
      prompt: 'count',
    });

    expect(aiMocks.generateObject).toHaveBeenCalledOnce();
    expect(result.object).toEqual({ count: 5 });
  });
});

describe('generateStructured — exhaustion', () => {
  it('throws a StructuredOutputError (UplnkError shape) when the fallback text is not JSON', async () => {
    aiMocks.generateObject.mockRejectedValue(makeValidationError('bad'));
    aiMocks.generateText.mockResolvedValueOnce({
      text: 'I would rather write a poem about counting.',
      usage: USAGE,
    });

    const err = await generateStructured({
      model: FAKE_MODEL,
      schema: CountSchema,
      prompt: 'count',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StructuredOutputError);
    expect((err as StructuredOutputError).code).toBe('STREAM_INVALID_RESPONSE');
    expect(isUplnkError(err)).toBe(true);
  });

  it('throws a StructuredOutputError when the fallback JSON fails schema validation', async () => {
    aiMocks.generateObject.mockRejectedValue(makeValidationError('bad'));
    aiMocks.generateText.mockResolvedValueOnce({
      text: '{"count": "not-a-number"}',
      usage: USAGE,
    });

    const err = await generateStructured({
      model: FAKE_MODEL,
      schema: CountSchema,
      prompt: 'count',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StructuredOutputError);
    expect((err as Error).message).toContain('schema validation');
  });

  it('propagates provider errors from the fallback unchanged', async () => {
    aiMocks.generateObject.mockRejectedValue(makeValidationError('bad'));
    const providerError = new Error('ECONNREFUSED 127.0.0.1:11434');
    aiMocks.generateText.mockRejectedValueOnce(providerError);

    await expect(
      generateStructured({ model: FAKE_MODEL, schema: CountSchema, prompt: 'count' }),
    ).rejects.toBe(providerError);
  });
});

describe('generateStructured — aborts', () => {
  it('rethrows immediately when the signal aborted mid-attempt (no retry, no fallback)', async () => {
    const controller = new AbortController();
    const abortError = new Error('The operation was aborted');
    aiMocks.generateObject.mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(abortError);
    });

    await expect(
      generateStructured({
        model: FAKE_MODEL,
        schema: CountSchema,
        prompt: 'count',
        abortSignal: controller.signal,
      }),
    ).rejects.toBe(abortError);

    expect(aiMocks.generateObject).toHaveBeenCalledOnce();
    expect(aiMocks.generateText).not.toHaveBeenCalled();
  });
});
