import { vi } from 'vitest';

export interface MockDelta {
  type: 'text-delta';
  textDelta: string;
}

export interface MockFinish {
  type: 'finish';
  usage: { promptTokens: number; completionTokens: number };
  finishReason: string;
}

export interface MockError {
  type: 'error';
  error: Error;
}

export type MockStreamEvent = MockDelta | MockFinish | MockError;

/**
 * Creates a mock for the `ai` module's streamText/generateText.
 *
 * Usage:
 *   vi.mock('ai', () => createAiModuleMock());
 *
 * Then in each test:
 *   setupStreamTextMock(['Hello', ' world'], { promptTokens: 10, completionTokens: 20 });
 */
export function createStreamTextMock(
  deltas: string[],
  opts: { usage?: { promptTokens: number; completionTokens: number } } = {},
) {
  const usage = opts.usage ?? { promptTokens: 5, completionTokens: 10 };

  async function* makeStream(): AsyncIterable<MockStreamEvent> {
    for (const delta of deltas) {
      yield { type: 'text-delta', textDelta: delta };
    }
    yield { type: 'finish', usage, finishReason: 'stop' };
  }

  return {
    fullStream: makeStream(),
    usage: Promise.resolve(usage),
    text: Promise.resolve(deltas.join('')),
  };
}

/**
 * Sets up vi.mocked(streamText) to return a scripted response.
 * Call this inside each test, after vi.mock('ai', ...) at file level.
 */
export function setupStreamTextMock(
  streamText: ReturnType<typeof vi.fn>,
  deltas: string[],
  opts: { usage?: { promptTokens: number; completionTokens: number } } = {},
) {
  streamText.mockReturnValueOnce(createStreamTextMock(deltas, opts));
}

/**
 * Sets up vi.mocked(generateText) to return a scripted text response.
 */
export function setupGenerateTextMock(
  generateText: ReturnType<typeof vi.fn>,
  text: string,
  opts: { usage?: { promptTokens: number; completionTokens: number } } = {},
) {
  generateText.mockResolvedValueOnce({
    text,
    usage: opts.usage ?? { promptTokens: 5, completionTokens: 10 },
    finishReason: 'stop',
  });
}

/** Sequences multiple generateText calls */
export function sequenceGenerateTextMock(
  generateText: ReturnType<typeof vi.fn>,
  responses: Array<string | Error>,
) {
  for (const response of responses) {
    if (response instanceof Error) {
      generateText.mockRejectedValueOnce(response);
    } else {
      generateText.mockResolvedValueOnce({
        text: response,
        usage: { promptTokens: 5, completionTokens: 10 },
        finishReason: 'stop',
      });
    }
  }
}
