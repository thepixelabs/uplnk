// @vitest-environment jsdom
/**
 * Tests for useCompare — parallel/sequential stream orchestration, blind/reveal,
 * vote persistence.
 *
 * Strategy
 *  - Mock 'ai' with a programmable streamText that the test controls per call.
 *    Each call returns a fullStream async iterator backed by a queue we push
 *    text-delta events into and a deferred end signal.
 *  - Drive the hook with @testing-library/react's renderHook + act, the same
 *    pattern used by useProviderConnectivity.test.tsx.
 *  - Vote persistence is tested by pointing scoreboardPath at a mkdtemp'd
 *    directory so no real ~/.uplnk file is touched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Hoisted ai mock ──────────────────────────────────────────────────────────

interface PaneStreamHandle {
  push: (delta: string) => void;
  finish: () => void;
  error: (err: Error) => void;
  aborted: () => boolean;
}

const aiMocks = vi.hoisted(() => {
  const handles: PaneStreamHandle[] = [];
  // streamText returns { fullStream: AsyncIterable<...> }. We back it with a
  // pending queue + a resolver so the test can advance the stream step by step.
  const streamText = vi.fn((opts: { abortSignal?: AbortSignal }) => {
    const queue: Array<{ type: 'text-delta'; textDelta: string } | { type: 'error'; error: Error } | { type: 'done' }> = [];
    let waiters: Array<() => void> = [];
    let finished = false;
    const handle: PaneStreamHandle = {
      push(delta: string) {
        queue.push({ type: 'text-delta', textDelta: delta });
        waiters.forEach((w) => w());
        waiters = [];
      },
      finish() {
        if (finished) return;
        finished = true;
        queue.push({ type: 'done' });
        waiters.forEach((w) => w());
        waiters = [];
      },
      error(err: Error) {
        queue.push({ type: 'error', error: err });
        waiters.forEach((w) => w());
        waiters = [];
      },
      aborted() {
        return opts.abortSignal?.aborted ?? false;
      },
    };
    handles.push(handle);

    const fullStream = {
      [Symbol.asyncIterator](): AsyncIterator<{ type: string; textDelta?: string; error?: Error }> {
        return {
          async next() {
            while (true) {
              if (opts.abortSignal?.aborted === true) {
                const err = new Error('aborted');
                err.name = 'AbortError';
                throw err;
              }
              const event = queue.shift();
              if (event !== undefined) {
                if (event.type === 'done') return { done: true, value: undefined };
                if (event.type === 'error') return { done: false, value: { type: 'error', error: event.error } };
                return { done: false, value: { type: 'text-delta', textDelta: event.textDelta } };
              }
              await new Promise<void>((resolve) => waiters.push(resolve));
            }
          },
        };
      },
    };
    return { fullStream };
  });

  return { streamText, handles };
});

vi.mock('ai', () => ({
  streamText: aiMocks.streamText,
}));

// ─── Imports after mock declaration ───────────────────────────────────────────

import type { LanguageModel } from 'ai';
import { useCompare } from '../useCompare.js';
import { readVotes } from '../../lib/compareScoreboard.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let scoreboardPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'uplnk-usecompare-'));
  scoreboardPath = join(tmpDir, 'compare-votes.json');
  aiMocks.streamText.mockClear();
  aiMocks.handles.length = 0;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function fakeModel(id: string): { languageModel: LanguageModel; modelId: string } {
  return {
    languageModel: { __id: id } as unknown as LanguageModel,
    modelId: id,
  };
}


// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useCompare — construction', () => {
  it('starts with one pane per model in idle status', () => {
    const { result } = renderHook(() =>
      useCompare({ models: [fakeModel('gpt-4o'), fakeModel('claude-3-5')], scoreboardPath }),
    );
    expect(result.current.panes).toHaveLength(2);
    expect(result.current.panes.every((p) => p.status === 'idle')).toBe(true);
  });

  it('assigns A/B labels in blind mode', () => {
    const { result } = renderHook(() =>
      useCompare({ models: [fakeModel('m1'), fakeModel('m2')], scoreboardPath, blind: true }),
    );
    expect(result.current.panes[0]?.displayLabel).toBe('A');
    expect(result.current.panes[1]?.displayLabel).toBe('B');
    expect(result.current.blinded).toBe(true);
  });

  it('shows real model ids when blind=false', () => {
    const { result } = renderHook(() =>
      useCompare({ models: [fakeModel('m1'), fakeModel('m2')], scoreboardPath, blind: false }),
    );
    expect(result.current.panes[0]?.displayLabel).toBe('m1');
    expect(result.current.panes[1]?.displayLabel).toBe('m2');
    expect(result.current.blinded).toBe(false);
  });

  it('throws when given zero models', () => {
    expect(() =>
      renderHook(() => useCompare({ models: [], scoreboardPath })),
    ).toThrow(/at least one model/);
  });

  it('throws when given more than 8 models', () => {
    const nine = Array.from({ length: 9 }, (_, i) => fakeModel(`m${i}`));
    expect(() =>
      renderHook(() => useCompare({ models: nine, scoreboardPath })),
    ).toThrow(/at most 8 panes/);
  });
});

describe('useCompare — parallel submit', () => {
  it('opens streams for every pane concurrently', async () => {
    const { result } = renderHook(() =>
      useCompare({ models: [fakeModel('m1'), fakeModel('m2')], scoreboardPath, parallel: true }),
    );
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = result.current.submit('hello');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(aiMocks.streamText).toHaveBeenCalledTimes(2);
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.currentPrompt).toBe('hello');

    // Drain so the pending promise doesn't dangle into the next test.
    await act(async () => {
      aiMocks.handles[0]?.finish();
      aiMocks.handles[1]?.finish();
      await pending;
    });
  });

  it('flushes streamed tokens into each pane independently', async () => {
    const { result } = renderHook(() =>
      useCompare({ models: [fakeModel('m1'), fakeModel('m2')], scoreboardPath, parallel: true }),
    );
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = result.current.submit('hello');
      await Promise.resolve();
      await Promise.resolve();
    });

    // Push deltas, then await the flush interval to land them in state.
    await act(async () => {
      aiMocks.handles[0]?.push('hi from A');
      aiMocks.handles[1]?.push('hi from B');
      await new Promise<void>((r) => setTimeout(r, 60));
    });

    expect(result.current.panes[0]?.streamedText).toBe('hi from A');
    expect(result.current.panes[1]?.streamedText).toBe('hi from B');

    // Tear down so the pending Promise doesn't dangle.
    await act(async () => {
      aiMocks.handles[0]?.finish();
      aiMocks.handles[1]?.finish();
      await pending;
    });
    expect(result.current.panes.every((p) => p.status === 'done')).toBe(true);
  });
});

describe('useCompare — sequential submit', () => {
  it('streams the second pane only after the first finishes', async () => {
    const { result } = renderHook(() =>
      useCompare({ models: [fakeModel('m1'), fakeModel('m2')], scoreboardPath, parallel: false }),
    );
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = result.current.submit('hi');
      await Promise.resolve();
      await Promise.resolve();
    });

    // Only the first stream should have opened so far.
    expect(aiMocks.streamText).toHaveBeenCalledTimes(1);

    // Finish pane 0 — pane 1 should then open.
    await act(async () => {
      aiMocks.handles[0]?.push('answer1');
      aiMocks.handles[0]?.finish();
      await new Promise<void>((r) => setTimeout(r, 80));
    });
    expect(aiMocks.streamText).toHaveBeenCalledTimes(2);

    await act(async () => {
      aiMocks.handles[1]?.push('answer2');
      aiMocks.handles[1]?.finish();
      await pending;
    });
    expect(result.current.panes[0]?.streamedText).toBe('answer1');
    expect(result.current.panes[1]?.streamedText).toBe('answer2');
  });
});

describe('useCompare — blind / reveal', () => {
  it('flips labels to model ids on reveal()', async () => {
    const { result } = renderHook(() =>
      useCompare({ models: [fakeModel('m1'), fakeModel('m2')], scoreboardPath, blind: true }),
    );
    expect(result.current.panes[0]?.displayLabel).toBe('A');
    await act(async () => {
      result.current.reveal();
    });
    expect(result.current.blinded).toBe(false);
    expect(result.current.panes[0]?.displayLabel).toBe('m1');
    expect(result.current.panes[1]?.displayLabel).toBe('m2');
  });

  it('re-blinds on a fresh submit when blind=true', async () => {
    const { result } = renderHook(() =>
      useCompare({ models: [fakeModel('m1'), fakeModel('m2')], scoreboardPath, blind: true }),
    );
    await act(async () => {
      result.current.reveal();
    });
    expect(result.current.blinded).toBe(false);

    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = result.current.submit('again');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.blinded).toBe(true);
    expect(result.current.panes[0]?.displayLabel).toBe('A');

    // Drain
    await act(async () => {
      aiMocks.handles[0]?.finish();
      aiMocks.handles[1]?.finish();
      await pending;
    });
  });
});

describe('useCompare — vote persistence', () => {
  it('writes the winner index, models, and current prompt', async () => {
    const { result } = renderHook(() =>
      useCompare({ models: [fakeModel('m1'), fakeModel('m2')], scoreboardPath, blind: true }),
    );

    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = result.current.submit('which is better?');
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      aiMocks.handles[0]?.finish();
      aiMocks.handles[1]?.finish();
      await pending;
    });

    await act(async () => {
      result.current.vote(0);
    });

    expect(existsSync(scoreboardPath)).toBe(true);
    const records = readVotes(scoreboardPath);
    expect(records).toHaveLength(1);
    expect(records[0]?.winner).toBe(0);
    expect(records[0]?.models).toEqual(['m1', 'm2']);
    expect(records[0]?.prompt).toBe('which is better?');
    expect(records[0]?.blind).toBe(true);
  });

  it('records a tie when voted', async () => {
    const { result } = renderHook(() =>
      useCompare({ models: [fakeModel('m1'), fakeModel('m2')], scoreboardPath }),
    );
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = result.current.submit('tie test');
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      aiMocks.handles[0]?.finish();
      aiMocks.handles[1]?.finish();
      await pending;
    });

    await act(async () => {
      result.current.vote('tie');
    });

    const records = readVotes(scoreboardPath);
    expect(records).toHaveLength(1);
    expect(records[0]?.winner).toBe('tie');
  });

  it('updates the in-memory scoreboard after a vote', async () => {
    const { result } = renderHook(() =>
      useCompare({ models: [fakeModel('m1'), fakeModel('m2')], scoreboardPath }),
    );
    expect(result.current.scoreboard).toEqual([]);

    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = result.current.submit('boop');
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      aiMocks.handles[0]?.finish();
      aiMocks.handles[1]?.finish();
      await pending;
    });
    await act(async () => {
      result.current.vote(0);
    });
    expect(result.current.scoreboard.find((r) => r.model === 'm1')?.wins).toBe(1);
    expect(result.current.scoreboard.find((r) => r.model === 'm2')?.losses).toBe(1);
  });

  it('no-ops when called with no prompt in memory', () => {
    const { result } = renderHook(() =>
      useCompare({ models: [fakeModel('m1'), fakeModel('m2')], scoreboardPath }),
    );
    act(() => {
      result.current.vote(0);
    });
    expect(existsSync(scoreboardPath)).toBe(false);
  });

  it('writes a truncated prompt on disk for >200-char prompts', async () => {
    const { result } = renderHook(() =>
      useCompare({ models: [fakeModel('m1'), fakeModel('m2')], scoreboardPath }),
    );
    const longPrompt = 'x'.repeat(400);
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = result.current.submit(longPrompt);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      aiMocks.handles[0]?.finish();
      aiMocks.handles[1]?.finish();
      await pending;
    });
    await act(async () => {
      result.current.vote(0);
    });
    const onDisk = JSON.parse(readFileSync(scoreboardPath, 'utf-8')) as Array<{ prompt: string }>;
    expect(onDisk[0]?.prompt.length).toBe(200);
  });
});

describe('useCompare — abort', () => {
  it('marks panes aborted when abortAll is called mid-stream', async () => {
    const { result } = renderHook(() =>
      useCompare({ models: [fakeModel('m1'), fakeModel('m2')], scoreboardPath, parallel: true }),
    );
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = result.current.submit('go');
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      aiMocks.handles[0]?.push('partial');
      await new Promise<void>((r) => setTimeout(r, 60));
    });

    await act(async () => {
      result.current.abortAll();
      // Nudge the iterators so they observe the aborted signal.
      aiMocks.handles[0]?.push('');
      aiMocks.handles[1]?.push('');
      await pending;
    });

    for (const pane of result.current.panes) {
      expect(['aborted', 'error']).toContain(pane.status);
    }
  });
});
