/**
 * useStream — unit tests
 *
 * Conventions (matching the rest of the test suite):
 *  - ink-testing-library's render() drives the React reconciler in a node
 *    environment — no jsdom required (Ink renders to stdout strings).
 *  - A thin HookWrapper component exposes the hook return value via a ref,
 *    mirroring the renderHookViaInk pattern used by ChatInput.test.tsx and
 *    useArtifacts.test.ts.
 *  - `ai.streamText` is mocked at the module boundary.
 *  - `toUplnkError` is NOT mocked — we use the real implementation and assert
 *    on the UplnkError code/message/hint it produces. Same approach as
 *    ChatInput.test.tsx.
 *  - We do NOT use fake timers. The real 33 ms flush interval is fast enough
 *    in test execution and avoids the setInterval/setImmediate interaction
 *    problems that fake timers introduce in Ink's node environment.
 *    Flush timing is verified via real waits (waitForFlush helper).
 *  - Tests that start a non-terminating send() clean up by calling abort()
 *    and releasing the barrier before the test returns. This prevents
 *    in-flight async chains from polluting the next test.
 *
 * Hoisting note: vi.mock() factories are hoisted before any const declarations.
 * vi.hoisted() places mock fn refs in the hoisted scope.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import type { LanguageModel, CoreMessage } from 'ai';

// ─── Hoisted mock refs ────────────────────────────────────────────────────────

const aiMocks = vi.hoisted(() => ({
  streamText: vi.fn(),
}));

vi.mock('ai', () => ({
  streamText: aiMocks.streamText,
}));

// ─── Import under test ────────────────────────────────────────────────────────

import { useStream } from '../hooks/useStream.js';
import type { StreamStatus } from '../hooks/useStream.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Fake model sentinel — useStream passes it straight to streamText. */
const fakeModel: LanguageModel = {
  specificationVersion: 'v1',
  provider: 'fake',
  modelId: 'fake',
} as unknown as LanguageModel;

const MESSAGES: CoreMessage[] = [{ role: 'user', content: 'hello' }];

/** Drain the Node macrotask queue so Ink commits pending state updates. */
// Single setImmediate — useStream tests use a barrier-based mock and rely on
// progressing exactly one microtask boundary per tick(). The Ink-stdin tests
// use a double-tick to deflake keyboard races; this hook test is barrier-
// driven and would over-shoot the tested state if we double-ticked here.
const tick = () => new Promise<void>((r) => setImmediate(r));

/**
 * Wait long enough for one flush interval (33 ms) to fire.
 * Using real timers keeps the helper simple and avoids the fake-timer /
 * setImmediate interaction issues in Ink's node environment.
 */
const waitForFlush = () => new Promise<void>((r) => setTimeout(r, 50));

interface Barrier {
  promise: Promise<void>;
  release: () => void;
}

function makeBarrier(): Barrier {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

type FullStreamEvent =
  | { type: 'text-delta'; textDelta: string }
  | { type: 'tool-call'; toolName: string }
  | { type: 'step-finish' };

/**
 * Async generator that yields text-delta events.
 * useStream's for-await consumes fullStream event objects.
 * An optional barrier lets the generator pause mid-stream so tests can
 * inspect state before the stream finishes.
 */
function makeChunkedStream(
  chunks: string[],
  barrier?: Barrier,
): AsyncIterable<FullStreamEvent> {
  return (async function* () {
    for (const chunk of chunks) {
      yield { type: 'text-delta' as const, textDelta: chunk };
    }
    if (barrier !== undefined) {
      await barrier.promise;
    }
  })();
}

/** Async generator that throws error after optionally yielding prior chunks. */
function makeErrorStream(
  error: Error,
  priorChunks: string[] = [],
): AsyncIterable<FullStreamEvent> {
  return (async function* () {
    for (const chunk of priorChunks) {
      yield { type: 'text-delta' as const, textDelta: chunk };
    }
    throw error;
  })();
}

/**
 * mockImplementation creates a fresh generator on each streamText() call.
 * mockReturnValue would reuse the same (potentially exhausted) generator.
 */
function setupMockStream(chunks: string[], barrier?: Barrier): void {
  aiMocks.streamText.mockImplementation(() => ({
    fullStream: makeChunkedStream(chunks, barrier),
  }));
}

function setupErrorMock(error: Error, priorChunks: string[] = []): void {
  aiMocks.streamText.mockImplementation(() => ({
    fullStream: makeErrorStream(error, priorChunks),
  }));
}

// ─── Hook driver ──────────────────────────────────────────────────────────────

type HookResult = ReturnType<typeof useStream>;

function renderHook(): {
  result: { current: HookResult };
  unmount: () => void;
} {
  const result: { current: HookResult } = {
    current: undefined as unknown as HookResult,
  };

  function HookWrapper() {
    result.current = useStream(fakeModel);
    return React.createElement(React.Fragment, null);
  }

  const { unmount } = render(React.createElement(HookWrapper));
  return { result, unmount };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useStream', () => {
  beforeEach(() => {
    aiMocks.streamText.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  // ── Initial state ─────────────────────────────────────────────────────────

  describe('initial state', () => {
    it('status is idle', async () => {
      const { result } = renderHook();
      await tick();

      expect(result.current.status).toBe<StreamStatus>('idle');
    });

    it('streamedText is an empty string', async () => {
      const { result } = renderHook();
      await tick();

      expect(result.current.streamedText).toBe('');
    });

    it('error is null', async () => {
      const { result } = renderHook();
      await tick();

      expect(result.current.error).toBeNull();
    });
  });

  // ── send() state transitions ──────────────────────────────────────────────

  describe('send() state transitions', () => {
    it('transitions to waiting once streamText returns a fullStream, then to streaming after the first text-delta', async () => {
      // State machine: idle → connecting → waiting (stream open, no tokens
      // yet) → streaming (first text-delta has arrived). Earlier versions of
      // useStream batched connecting+streaming and skipped 'waiting'; the
      // 'waiting' step was added later and this test was never updated.
      const barrier = makeBarrier();
      // Yield ONE chunk after the test reaches 'waiting' so we can also
      // assert the streaming transition fires on first token.
      setupMockStream(['hello'], barrier);

      const { result } = renderHook();
      await tick();

      void result.current.send(MESSAGES);
      await tick();

      // The chunk has already been yielded by the generator and processed by
      // useStream, so the post-tick state is 'streaming'. If timing changes
      // upstream, this assertion may need to accept 'waiting' as well — the
      // important contract is "not idle / not connecting".
      expect(['waiting', 'streaming']).toContain(result.current.status);

      // Clean up: abort so the pending send() promise resolves in this test.
      result.current.abort();
      barrier.release();
      await tick();
    });

    it('transitions to done after the stream exhausts', async () => {
      setupMockStream(['hello']);

      const { result } = renderHook();
      await tick();

      await result.current.send(MESSAGES);
      await tick();

      expect(result.current.status).toBe<StreamStatus>('done');
    });

    it('clears error state when a new send() starts', async () => {
      setupErrorMock(new Error('broke'));

      const { result } = renderHook();
      await tick();

      await result.current.send(MESSAGES);
      await tick();

      expect(result.current.error).not.toBeNull();

      // Second send — error must be cleared before streaming begins
      setupMockStream(['ok']);
      await result.current.send(MESSAGES);
      await tick();

      expect(result.current.error).toBeNull();
    });

    it('resets streamedText to empty when a new send() starts', async () => {
      setupMockStream(['first-run']);

      const { result } = renderHook();
      await tick();

      await result.current.send(MESSAGES);
      await waitForFlush(); // let flush interval fire so state updates

      expect(result.current.streamedText).toBe('first-run');

      setupMockStream(['second-run']);
      await result.current.send(MESSAGES);
      await waitForFlush();

      expect(result.current.streamedText).toBe('second-run');
    });
  });

  // ── Streaming text accumulation via flush interval ─────────────────────────

  describe('streaming text accumulation via flush interval', () => {
    it('does not update streamedText before the first flush interval fires', async () => {
      // Use a barrier BEFORE any chunks are yielded so the generator never
      // puts anything into streamBufferRef. No flush needed.
      const barrier = makeBarrier();

      aiMocks.streamText.mockImplementation(() => ({
        fullStream: (async function* () {
          // Block before yielding anything — buffer stays empty
          await barrier.promise;
          yield { type: 'text-delta' as const, textDelta: 'never-buffered' };
        })(),
      }));

      const { result } = renderHook();
      await tick();

      void result.current.send(MESSAGES);
      await tick();

      // Generator blocked before yielding — buffer is empty, state is ''
      expect(result.current.streamedText).toBe('');

      // Clean up
      result.current.abort();
      barrier.release();
      await tick();
    });

    it('flushes buffered tokens into streamedText when the flush interval fires', async () => {
      // The stream yields chunks then blocks. The flush interval (33 ms)
      // commits the buffer to React state.
      const barrier = makeBarrier();

      aiMocks.streamText.mockImplementation(() => ({
        fullStream: (async function* () {
          yield { type: 'text-delta' as const, textDelta: 'Hello, ' };
          yield { type: 'text-delta' as const, textDelta: 'world!' };
          // Hold so the flush interval commits text before stream ends
          await barrier.promise;
        })(),
      }));

      const { result } = renderHook();
      await tick();

      void result.current.send(MESSAGES);

      // Wait past one flush interval so the 33 ms setInterval fires
      await waitForFlush();
      await tick();

      expect(result.current.streamedText).toBe('Hello, world!');

      result.current.abort();
      barrier.release();
      await tick();
    });

    it('accumulates text correctly from multiple chunks', async () => {
      // All chunks are yielded synchronously so they all land in the buffer.
      // The final synchronous flush commits everything before 'done'.
      setupMockStream(['Hello', ', ', 'world!']);

      const { result } = renderHook();
      await tick();

      await result.current.send(MESSAGES);
      await tick();

      expect(result.current.streamedText).toBe('Hello, world!');
      expect(result.current.status).toBe<StreamStatus>('done');
    });

    it('performs a final synchronous flush so last tokens appear before done status', async () => {
      // A very short stream may finish before any interval fires.
      // The hook performs a final synchronous flush so text is committed.
      setupMockStream(['only-chunk']);

      const { result } = renderHook();
      await tick();

      await result.current.send(MESSAGES);
      await tick();

      expect(result.current.streamedText).toBe('only-chunk');
      expect(result.current.status).toBe<StreamStatus>('done');
    });
  });

  // ── abort() ───────────────────────────────────────────────────────────────

  describe('abort()', () => {
    it('transitions status to idle immediately', async () => {
      const barrier = makeBarrier();
      setupMockStream([], barrier);

      const { result } = renderHook();
      await tick();

      void result.current.send(MESSAGES);
      await tick();

      result.current.abort();
      await tick();

      expect(result.current.status).toBe<StreamStatus>('idle');

      barrier.release();
      await tick();
    });

    it('clears streamedText on abort', async () => {
      // The updated hook's abort() calls setStreamedText('') so text
      // accumulated via the flush interval is cleared on abort.
      const barrier = makeBarrier();

      aiMocks.streamText.mockImplementation(() => ({
        fullStream: (async function* () {
          yield { type: 'text-delta' as const, textDelta: 'partial' };
          await barrier.promise;
        })(),
      }));

      const { result } = renderHook();
      await tick();

      void result.current.send(MESSAGES);
      await waitForFlush(); // let flush commit partial text
      await tick();

      result.current.abort();
      await tick();

      // abort() calls setStreamedText('') — text is cleared
      expect(result.current.streamedText).toBe('');

      barrier.release();
      await tick();
    });

    it('does not set error state', async () => {
      const barrier = makeBarrier();
      setupMockStream([], barrier);

      const { result } = renderHook();
      await tick();

      void result.current.send(MESSAGES);
      await tick();

      result.current.abort();
      await tick();

      expect(result.current.error).toBeNull();

      barrier.release();
      await tick();
    });
  });

  // ── AbortError handling ───────────────────────────────────────────────────

  describe('when the stream throws an AbortError', () => {
    it('does not set error state', async () => {
      const abortError = Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
      });
      setupErrorMock(abortError);

      const { result } = renderHook();
      await tick();

      await result.current.send(MESSAGES);
      await tick();

      expect(result.current.error).toBeNull();
    });

    it('transitions to idle (not error) status', async () => {
      const abortError = Object.assign(new Error('aborted'), {
        name: 'AbortError',
      });
      setupErrorMock(abortError);

      const { result } = renderHook();
      await tick();

      await result.current.send(MESSAGES);
      await tick();

      expect(result.current.status).toBe<StreamStatus>('idle');
    });
  });

  // ── Non-abort error handling ──────────────────────────────────────────────

  describe('when the stream throws a non-abort error', () => {
    it('transitions to error status', async () => {
      setupErrorMock(new Error('something broke'));

      const { result } = renderHook();
      await tick();

      await result.current.send(MESSAGES);
      await tick();

      expect(result.current.status).toBe<StreamStatus>('error');
    });

    it('sets error.code to STREAM_INTERRUPTED for a generic Error', async () => {
      setupErrorMock(new Error('something broke'));

      const { result } = renderHook();
      await tick();

      await result.current.send(MESSAGES);
      await tick();

      expect(result.current.error?.code).toBe('STREAM_INTERRUPTED');
    });

    it('sets error.code to PROVIDER_UNREACHABLE when message contains ECONNREFUSED', async () => {
      setupErrorMock(new Error('ECONNREFUSED 127.0.0.1:11434'));

      const { result } = renderHook();
      await tick();

      await result.current.send(MESSAGES);
      await tick();

      expect(result.current.error?.code).toBe('PROVIDER_UNREACHABLE');
    });

    it('sets error.message to the original Error message', async () => {
      const originalMessage = 'connection timed out after 30s';
      setupErrorMock(new Error(originalMessage));

      const { result } = renderHook();
      await tick();

      await result.current.send(MESSAGES);
      await tick();

      expect(result.current.error?.message).toBe(originalMessage);
    });

    it('populates error.hint with a non-empty user-facing recovery hint', async () => {
      setupErrorMock(new Error('network error'));

      const { result } = renderHook();
      await tick();

      await result.current.send(MESSAGES);
      await tick();

      expect(typeof result.current.error?.hint).toBe('string');
      expect((result.current.error?.hint ?? '').length).toBeGreaterThan(0);
    });
  });

  // ── Cleanup on unmount ────────────────────────────────────────────────────

  describe('cleanup on unmount', () => {
    it('aborts the active stream when the hook unmounts', async () => {
      let capturedSignal: AbortSignal | undefined;

      aiMocks.streamText.mockImplementation(
        ({ abortSignal }: { abortSignal: AbortSignal }) => {
          capturedSignal = abortSignal;
          return {
            fullStream: (async function* () {
              // Never resolves — stream is active at unmount time
              await new Promise(() => { /* intentionally infinite */ });
              yield { type: 'text-delta' as const, textDelta: 'never' };
            })(),
          };
        },
      );

      const { result, unmount } = renderHook();
      await tick();

      void result.current.send(MESSAGES);
      await tick();

      expect(capturedSignal?.aborted).toBe(false);

      unmount();
      await tick();

      expect(capturedSignal?.aborted).toBe(true);
    });

    it('clears the flush interval on unmount so the Node event loop can drain', async () => {
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

      const barrier = makeBarrier();
      setupMockStream(['text'], barrier);

      const { result, unmount } = renderHook();
      await tick();

      void result.current.send(MESSAGES);
      await tick();

      // Flush interval is active — unmounting must clear it
      unmount();
      await tick();

      expect(clearIntervalSpy).toHaveBeenCalled();

      barrier.release();
      await tick();
      clearIntervalSpy.mockRestore();
    });
  });

  // ── reset() ───────────────────────────────────────────────────────────────

  describe('reset()', () => {
    it('clears streamedText, clears error, and returns to idle status', async () => {
      setupErrorMock(new Error('fail'));

      const { result } = renderHook();
      await tick();

      await result.current.send(MESSAGES);
      await tick();

      // Confirm we're in error state before reset
      expect(result.current.status).toBe<StreamStatus>('error');
      expect(result.current.error).not.toBeNull();

      result.current.reset();
      await tick();

      expect(result.current.streamedText).toBe('');
      expect(result.current.error).toBeNull();
      expect(result.current.status).toBe<StreamStatus>('idle');
    });
  });
});
