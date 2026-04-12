/**
 * watcher.ts — incremental re-indexing on file changes.
 *
 * Uses chokidar (available in node_modules) to watch a directory for file
 * changes and debounces re-indexing with a 1-second delay.
 *
 * Architecture:
 * - One FSWatcher per watched directory.
 * - Pending changed paths are collected during the debounce window and all
 *   processed together when the debounce fires.
 * - Deleted files have their chunks removed from the DB immediately.
 * - The watcher can be stopped via stop().
 */

import chokidar, { type FSWatcher } from 'chokidar';
import type { Indexer } from './indexer.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface WatcherOptions {
  /** Debounce delay in milliseconds. Default: 1000. */
  debounceMs?: number | undefined;
  /** Called after each debounced re-index batch with the affected paths. */
  onIndexed?: ((paths: string[]) => void) | undefined;
  /** Called when a file is deleted and its chunks removed. */
  onDeleted?: ((filePath: string) => void) | undefined;
  /** Called on any error from chokidar. */
  onError?: ((err: Error) => void) | undefined;
}

// ─── Internal resolved options ────────────────────────────────────────────────

interface ResolvedWatcherOptions {
  debounceMs: number;
  onIndexed: (paths: string[]) => void;
  onDeleted: (filePath: string) => void;
  onError: (err: Error) => void;
}

// ─── RagWatcher ─────────────────────────────────────────────────────────────────

export class RagWatcher {
  private readonly indexer: Indexer;
  private readonly rootDir: string;
  private readonly options: ResolvedWatcherOptions;
  private watcher: FSWatcher | null = null;
  private pendingPaths = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(indexer: Indexer, rootDir: string, options?: WatcherOptions | undefined) {
    this.indexer = indexer;
    this.rootDir = rootDir;
    this.options = {
      debounceMs: options?.debounceMs ?? 1000,
      onIndexed: options?.onIndexed ?? (() => undefined),
      onDeleted: options?.onDeleted ?? (() => undefined),
      onError: options?.onError ?? ((err: Error) => process.stderr.write(`[rag watcher] ${err.message}\n`)),
    };
  }

  /**
   * Start watching rootDir for changes.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  start(): void {
    if (this.watcher !== null) return;

    this.watcher = chokidar.watch(this.rootDir, {
      persistent: false,
      ignoreInitial: true,           // don't fire for existing files on start
      ignored: [
        /(^|[/\\])\..+/,             // hidden files/dirs
        /node_modules/,
        /\.git\b/,
        /dist\b/,
        /build\b/,
        /coverage\b/,
      ],
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    });

    this.watcher.on('add', (filePath: string) => this.scheduleReindex(filePath));
    this.watcher.on('change', (filePath: string) => this.scheduleReindex(filePath));
    this.watcher.on('unlink', (filePath: string) => this.handleDelete(filePath));
    this.watcher.on('error', (err: unknown) => {
      this.options.onError(err instanceof Error ? err : new Error(String(err)));
    });
  }

  /**
   * Stop the file watcher and cancel any pending debounce timer.
   */
  async stop(): Promise<void> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingPaths.clear();

    if (this.watcher !== null) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Schedule a re-index of the given file path.
   * Multiple changes within debounceMs are batched together.
   */
  scheduleReindex(filePath: string): void {
    this.pendingPaths.add(filePath);

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flushPending();
    }, this.options.debounceMs);
  }

  /**
   * Flush all pending paths — index each changed file.
   */
  private async flushPending(): Promise<void> {
    const paths = [...this.pendingPaths];
    this.pendingPaths.clear();

    const indexed: string[] = [];
    for (const filePath of paths) {
      try {
        const result = await this.indexer.indexFile(filePath, this.rootDir);
        if (result.indexed > 0) {
          indexed.push(filePath);
        }
      } catch {
        // Indexing failure — skip silently (file may have been deleted between event and flush)
      }
    }

    if (indexed.length > 0) {
      this.options.onIndexed(indexed);
    }
  }

  /**
   * Remove chunks for a deleted file.
   */
  private handleDelete(filePath: string): void {
    // Remove from pending (no point re-indexing a deleted file)
    this.pendingPaths.delete(filePath);

    try {
      this.indexer.deleteFile(filePath);
      this.options.onDeleted(filePath);
    } catch {
      // Non-fatal
    }
  }

  /** For testing: force immediate flush of pending paths (bypasses debounce). */
  async flushNow(): Promise<void> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pendingPaths.size > 0) {
      await this.flushPending();
    }
  }
}
