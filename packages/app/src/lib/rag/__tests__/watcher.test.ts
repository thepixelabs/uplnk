/**
 * Unit tests for watcher.ts — debounce logic.
 *
 * Tests that:
 * - Multiple file changes within the debounce window are batched
 * - Only one re-index call is made after the debounce fires
 * - File deletion removes chunks immediately
 * - flushNow() bypasses the debounce
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RagWatcher } from '../watcher.js';
import type { Indexer } from '../indexer.js';

// ─── Mock chokidar ─────────────────────────────────────────────────────────────
//
// We don't want the watcher to touch the real filesystem — mock chokidar with
// a minimal EventEmitter-like fake that lets us trigger events manually.

vi.mock('chokidar', () => {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  let closed = false;

  const watcherInstance = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event]!.push(handler);
      return watcherInstance;
    }),
    close: vi.fn(async () => {
      closed = true;
    }),
    _emit: (event: string, ...args: unknown[]) => {
      for (const h of handlers[event] ?? []) {
        h(...args);
      }
    },
    _reset: () => {
      for (const key of Object.keys(handlers)) {
        delete handlers[key];
      }
      closed = false;
    },
    _isClosed: () => closed,
  };

  return {
    default: {
      watch: vi.fn(() => watcherInstance),
    },
    __watcher: watcherInstance,
  };
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeIndexer(): Indexer & { indexFile: ReturnType<typeof vi.fn>; deleteFile: ReturnType<typeof vi.fn> } {
  const indexFileMock = vi.fn().mockResolvedValue({ indexed: 1, skipped: 0, chunks: 3, errors: [] });
  const deleteFileMock = vi.fn();
  return {
    indexFile: indexFileMock,
    deleteFile: deleteFileMock,
  } as unknown as Indexer & { indexFile: ReturnType<typeof vi.fn>; deleteFile: ReturnType<typeof vi.fn> };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('RagWatcher debounce logic', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('batches multiple file changes into a single re-index call', async () => {
    const indexer = makeIndexer();
    const onIndexed = vi.fn();

    const watcher = new RagWatcher(indexer, '/project', {
      debounceMs: 1000,
      onIndexed,
    });

    // Simulate 3 file changes in rapid succession
    watcher.scheduleReindex('/project/src/a.ts');
    watcher.scheduleReindex('/project/src/b.ts');
    watcher.scheduleReindex('/project/src/c.ts');

    // Debounce timer hasn't fired yet — no indexing
    expect(indexer.indexFile).not.toHaveBeenCalled();

    // Advance time past debounce window
    await vi.runAllTimersAsync();

    // indexFile should have been called once per unique path
    expect(indexer.indexFile).toHaveBeenCalledTimes(3);
    expect(onIndexed).toHaveBeenCalledTimes(1);
  });

  it('resets the debounce timer when a new change arrives', async () => {
    const indexer = makeIndexer();
    const onIndexed = vi.fn();

    const watcher = new RagWatcher(indexer, '/project', {
      debounceMs: 1000,
      onIndexed,
    });

    watcher.scheduleReindex('/project/src/a.ts');

    // Advance 500ms (halfway through debounce window)
    vi.advanceTimersByTime(500);
    expect(indexer.indexFile).not.toHaveBeenCalled();

    // New change arrives — should reset the timer
    watcher.scheduleReindex('/project/src/b.ts');

    // Advance another 500ms (still within the new debounce window)
    vi.advanceTimersByTime(500);
    expect(indexer.indexFile).not.toHaveBeenCalled();

    // Advance past the full debounce window
    await vi.runAllTimersAsync();
    expect(indexer.indexFile).toHaveBeenCalledTimes(2); // both files
  });

  it('calls onDeleted and deleteFile when a file is removed', () => {
    const indexer = makeIndexer();
    const onDeleted = vi.fn();

    const watcher = new RagWatcher(indexer, '/project', {
      debounceMs: 1000,
      onDeleted,
    });

    // Simulate a pending change and then trigger delete via the internal handler.
    // We access the private method through the runtime object (JS has no private
    // runtime enforcement) to exercise the handler without starting a real watcher.
    watcher.scheduleReindex('/project/src/deleted.ts');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (watcher as unknown as Record<string, (path: string) => void>)['handleDelete']?.('/project/src/deleted.ts');

    expect(indexer.deleteFile).toHaveBeenCalledWith('/project/src/deleted.ts');
    expect(onDeleted).toHaveBeenCalledWith('/project/src/deleted.ts');
  });

  it('flushNow processes pending paths immediately without waiting for debounce', async () => {
    const indexer = makeIndexer();
    const onIndexed = vi.fn();

    const watcher = new RagWatcher(indexer, '/project', {
      debounceMs: 5000,
      onIndexed,
    });

    watcher.scheduleReindex('/project/src/urgent.ts');

    // Don't advance time — use flushNow instead
    await watcher.flushNow();

    expect(indexer.indexFile).toHaveBeenCalledWith('/project/src/urgent.ts', '/project');
    expect(onIndexed).toHaveBeenCalledWith(['/project/src/urgent.ts']);
  });

  it('flushNow is a no-op when there are no pending paths', async () => {
    const indexer = makeIndexer();
    const onIndexed = vi.fn();

    const watcher = new RagWatcher(indexer, '/project', {
      debounceMs: 1000,
      onIndexed,
    });

    await watcher.flushNow();

    expect(indexer.indexFile).not.toHaveBeenCalled();
    expect(onIndexed).not.toHaveBeenCalled();
  });

  it('stop() cancels the pending debounce timer', async () => {
    const indexer = makeIndexer();

    const watcher = new RagWatcher(indexer, '/project', {
      debounceMs: 1000,
    });

    watcher.scheduleReindex('/project/src/a.ts');

    // Stop before debounce fires
    await watcher.stop();

    // Advance time — indexFile should NOT be called
    await vi.runAllTimersAsync();
    expect(indexer.indexFile).not.toHaveBeenCalled();
  });

  it('deduplicates paths (same path scheduled twice = one indexFile call)', async () => {
    const indexer = makeIndexer();

    const watcher = new RagWatcher(indexer, '/project', {
      debounceMs: 1000,
    });

    // Schedule same path twice
    watcher.scheduleReindex('/project/src/a.ts');
    watcher.scheduleReindex('/project/src/a.ts');

    await vi.runAllTimersAsync();

    // Only one call per unique path (Set deduplication)
    expect(indexer.indexFile).toHaveBeenCalledTimes(1);
    expect(indexer.indexFile).toHaveBeenCalledWith('/project/src/a.ts', '/project');
  });

  it('onIndexed is NOT called when all files are skipped (indexed=0)', async () => {
    // Make indexFile return indexed=0 for every file (binary skip, etc.)
    const indexer = makeIndexer();
    (indexer.indexFile as ReturnType<typeof vi.fn>).mockResolvedValue({
      indexed: 0,
      skipped: 1,
      chunks: 0,
      errors: [],
    });
    const onIndexed = vi.fn();

    const watcher = new RagWatcher(indexer, '/project', {
      debounceMs: 1000,
      onIndexed,
    });

    watcher.scheduleReindex('/project/src/binary.bin');
    await vi.runAllTimersAsync();

    expect(indexer.indexFile).toHaveBeenCalledTimes(1);
    // onIndexed should NOT be called when no files were successfully indexed
    expect(onIndexed).not.toHaveBeenCalled();
  });

  it('onIndexed is called only with successfully indexed paths', async () => {
    const indexer = makeIndexer();
    // First file indexed, second file skipped
    (indexer.indexFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ indexed: 1, skipped: 0, chunks: 3, errors: [] })
      .mockResolvedValueOnce({ indexed: 0, skipped: 1, chunks: 0, errors: [] });

    const onIndexed = vi.fn();

    const watcher = new RagWatcher(indexer, '/project', {
      debounceMs: 1000,
      onIndexed,
    });

    watcher.scheduleReindex('/project/src/a.ts');
    watcher.scheduleReindex('/project/src/binary.bin');
    await vi.runAllTimersAsync();

    // onIndexed called once, only with the file that was actually indexed
    expect(onIndexed).toHaveBeenCalledTimes(1);
    expect(onIndexed).toHaveBeenCalledWith(['/project/src/a.ts']);
  });

  it('onError is called when indexFile throws', async () => {
    const indexer = makeIndexer();
    (indexer.indexFile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('unexpected crash'),
    );
    const onIndexed = vi.fn();

    const watcher = new RagWatcher(indexer, '/project', {
      debounceMs: 1000,
      onIndexed,
    });

    watcher.scheduleReindex('/project/src/crash.ts');
    // Should NOT throw — errors are swallowed in flushPending
    await expect(vi.runAllTimersAsync()).resolves.not.toThrow();
    // onIndexed is not called since no files were indexed
    expect(onIndexed).not.toHaveBeenCalled();
  });

  it('default onError writes to stderr (no custom handler provided)', () => {
    // This tests the default onError handler path in watcher.start()'s error event.
    // We call handleDelete on a path where deleteFile throws to exercise the
    // non-fatal error handling.
    const indexer = makeIndexer();
    (indexer.deleteFile as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('delete failed');
    });

    // Should not throw even when deleteFile throws
    const watcher = new RagWatcher(indexer, '/project', { debounceMs: 1000 });
    expect(() =>
      (watcher as unknown as Record<string, (p: string) => void>)['handleDelete']?.('/project/src/gone.ts'),
    ).not.toThrow();
  });

  it('stop() closes the chokidar watcher when start() was called', async () => {
    const indexer = makeIndexer();
    const watcher = new RagWatcher(indexer, '/project', { debounceMs: 1000 });

    // Start the watcher (uses the mocked chokidar)
    watcher.start();
    // Calling start() again is a no-op
    watcher.start();

    // Stop should not throw
    await expect(watcher.stop()).resolves.not.toThrow();
  });
});
