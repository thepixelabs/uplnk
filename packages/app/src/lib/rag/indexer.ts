/**
 * indexer.ts — filesystem walker + chunker for RAG indexing.
 *
 * Walks a directory, respects .gitignore patterns, skips binary files,
 * chunks source text (512-token chunks with 64-token overlap), generates
 * embeddings via the Embedder, and stores chunks + embeddings in SQLite.
 *
 * Design choices:
 * - Token counts are approximated as "characters / 4" (typical for code). This
 *   avoids pulling in a full tokenizer and is accurate enough for chunk sizing.
 * - Binary detection: if any byte in the first 8 KiB is a null byte, treat the
 *   file as binary and skip it.
 * - .gitignore support: reads the root .gitignore (and any ancestor .gitignore
 *   in allowedRoots) and filters matching paths.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Db } from '@uplnk/db';
import { ragChunks } from '@uplnk/db';
import { eq, isNotNull } from 'drizzle-orm';
import type { Embedder } from './embedder.js';
import { serializeEmbedding } from './embedder.js';

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Approximate tokens per character for code (chars / CHARS_PER_TOKEN). */
const CHARS_PER_TOKEN = 4;
const CHUNK_TOKENS = 512;
const OVERLAP_TOKENS = 64;

const CHUNK_CHARS = CHUNK_TOKENS * CHARS_PER_TOKEN;    // 2048 chars
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN; // 256 chars

/** Always-skip directory names regardless of .gitignore. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.pnpm',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.next',
  '__pycache__',
  '.venv',
  'venv',
]);

/** Max file size to index (1 MiB). Larger files are skipped. */
const MAX_FILE_BYTES = 1 * 1024 * 1024;

/** Number of bytes to inspect when detecting binary files. */
const BINARY_CHECK_BYTES = 8192;

// ─── Gitignore pattern parser ──────────────────────────────────────────────────

/**
 * Minimal .gitignore parser — converts gitignore glob lines to RegExps.
 * Handles the most common patterns:
 *   - blank lines and # comments are ignored
 *   - leading / anchors to the repo root
 *   - trailing / means directory-only
 *   - ** is a multi-segment wildcard
 *   - * is a single-segment wildcard
 */
function parseGitignore(content: string, rootDir: string): Array<(relPath: string) => boolean> {
  const matchers: Array<(relPath: string) => boolean> = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (line.startsWith('!')) continue; // negation patterns — skip for simplicity

    const anchored = line.startsWith('/');
    const dirOnly = line.endsWith('/');
    const pattern = line.replace(/^\//, '').replace(/\/$/, '');

    // Convert glob to regexp
    const regexpStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex metacharacters
      .replace(/\*\*/g, '\x00') // placeholder for **
      .replace(/\*/g, '[^/]*') // * matches within a segment
      .replace(/\x00/g, '.*'); // ** matches across segments

    let regexp: RegExp;
    try {
      regexp = anchored
        ? new RegExp(`^${regexpStr}(/|$)`)
        : new RegExp(`(^|/)${regexpStr}(/|$)`);
    } catch {
      continue; // malformed pattern — skip
    }

    void rootDir; // captured for future use
    matchers.push((relPath: string) => {
      const testPath = dirOnly ? relPath + '/' : relPath;
      return regexp.test(testPath);
    });
  }

  return matchers;
}

/**
 * Load gitignore matchers from a directory.
 * Returns an empty array if no .gitignore is found.
 */
function loadGitignoreMatchers(dir: string): Array<(relPath: string) => boolean> {
  const gitignorePath = join(dir, '.gitignore');
  if (!existsSync(gitignorePath)) return [];

  try {
    const content = readFileSync(gitignorePath, 'utf-8');
    return parseGitignore(content, dir);
  } catch {
    return [];
  }
}

// ─── Binary file detection ─────────────────────────────────────────────────────

function isBinaryFile(filePath: string): boolean {
  try {
    const fd = readFileSync(filePath);
    const slice = fd.subarray(0, BINARY_CHECK_BYTES);
    // If any byte is null (0x00), treat as binary
    for (let i = 0; i < slice.length; i++) {
      if (slice[i] === 0) return true;
    }
    return false;
  } catch {
    return true; // unreadable — treat as binary / skip
  }
}

// ─── Chunker ───────────────────────────────────────────────────────────────────

/**
 * Split text into overlapping chunks of approximately CHUNK_TOKENS tokens.
 * Returns an array of { chunkIndex, content } objects.
 *
 * Strategy: slide a window of CHUNK_CHARS characters with OVERLAP_CHARS overlap.
 * We try to snap chunk boundaries to newlines to avoid splitting mid-line.
 */
export function chunkText(text: string): Array<{ chunkIndex: number; content: string }> {
  if (text.length === 0) return [];

  const chunks: Array<{ chunkIndex: number; content: string }> = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < text.length) {
    let end = start + CHUNK_CHARS;

    if (end < text.length) {
      // Snap to a newline boundary within a small lookahead window
      const lookAhead = Math.min(end + 256, text.length);
      const newlinePos = text.lastIndexOf('\n', lookAhead);
      // Only snap if the newline is well into the chunk (avoids tiny chunks)
      if (newlinePos > start + OVERLAP_CHARS) {
        end = newlinePos + 1;
      }
    } else {
      end = text.length;
    }

    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push({ chunkIndex, content: chunk });
      chunkIndex++;
    }

    // Advance with overlap. The stride must be at least 1 char to guarantee
    // termination, and at least CHUNK_CHARS - OVERLAP_CHARS to ensure we make
    // meaningful progress (otherwise tiny overlap can cause near-infinite loops
    // near the end of the text).
    const nextStart = end - OVERLAP_CHARS;
    if (nextStart <= start) {
      // Safety: no forward progress — break to avoid infinite loop
      break;
    }
    start = nextStart;
  }

  return chunks;
}

// ─── Index result ──────────────────────────────────────────────────────────────

export interface IndexResult {
  /** Files successfully indexed */
  indexed: number;
  /** Files skipped (binary, too large, unreadable) */
  skipped: number;
  /** Chunks written to DB */
  chunks: number;
  /** Errors encountered */
  errors: string[];
}

// ─── Indexer class ─────────────────────────────────────────────────────────────

export class Indexer {
  private readonly db: Db;
  private readonly embedder: Embedder | null;

  constructor(db: Db, embedder: Embedder | null) {
    this.db = db;
    this.embedder = embedder;
  }

  /**
   * Index all eligible files under `rootDir`.
   * Existing chunks for each file are replaced (delete-then-insert) so
   * re-indexing a file always reflects the current content.
   */
  async indexDirectory(rootDir: string): Promise<IndexResult> {
    const result: IndexResult = { indexed: 0, skipped: 0, chunks: 0, errors: [] };

    const gitignoreMatchers = loadGitignoreMatchers(rootDir);

    const filePaths = this.walkDirectory(rootDir, rootDir, gitignoreMatchers);

    for (const filePath of filePaths) {
      const fileResult = await this.indexFile(filePath, rootDir);
      result.indexed += fileResult.indexed;
      result.skipped += fileResult.skipped;
      result.chunks += fileResult.chunks;
      result.errors.push(...fileResult.errors);
    }

    return result;
  }

  /**
   * Index a single file. Deletes existing chunks for this file first.
   * Returns a partial IndexResult for merging.
   */
  async indexFile(filePath: string, _rootDir?: string | undefined): Promise<IndexResult> {
    const result: IndexResult = { indexed: 0, skipped: 0, chunks: 0, errors: [] };

    // Skip large files
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch (err) {
      result.errors.push(`stat(${filePath}): ${err instanceof Error ? err.message : String(err)}`);
      result.skipped++;
      return result;
    }

    if (size > MAX_FILE_BYTES) {
      result.skipped++;
      return result;
    }

    // Skip binary files
    if (isBinaryFile(filePath)) {
      result.skipped++;
      return result;
    }

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (err) {
      result.errors.push(`read(${filePath}): ${err instanceof Error ? err.message : String(err)}`);
      result.skipped++;
      return result;
    }

    // Delete existing chunks for this file
    try {
      this.db.delete(ragChunks).where(eq(ragChunks.filePath, filePath)).run();
    } catch {
      // Non-fatal: if delete fails, insert may duplicate — acceptable for robustness
    }

    const textChunks = chunkText(content);
    if (textChunks.length === 0) {
      result.skipped++;
      return result;
    }

    const now = new Date().toISOString();

    for (const { chunkIndex, content: chunkContent } of textChunks) {
      let embeddingBlob: Buffer | null = null;

      if (this.embedder !== null) {
        try {
          const embedResult = await this.embedder.embed(chunkContent);
          if (embedResult !== null) {
            embeddingBlob = serializeEmbedding(embedResult.vector);
          }
        } catch {
          // Embedding failure — store chunk without embedding, can re-embed later
        }
      }

      try {
        this.db.insert(ragChunks).values({
          id: randomUUID(),
          filePath,
          chunkIndex,
          content: chunkContent,
          embedding: embeddingBlob,
          indexedAt: now,
        }).run();
        result.chunks++;
      } catch (err) {
        result.errors.push(`insert chunk(${filePath}:${chunkIndex}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    result.indexed++;
    return result;
  }

  /**
   * Remove all RAG chunks for a file path (called on file delete events).
   */
  deleteFile(filePath: string): void {
    this.db.delete(ragChunks).where(eq(ragChunks.filePath, filePath)).run();
  }

  /**
   * Walk a directory recursively, returning absolute file paths.
   * Skips SKIP_DIRS and gitignore-matched entries.
   */
  private walkDirectory(
    dir: string,
    rootDir: string,
    gitignoreMatchers: Array<(relPath: string) => boolean>,
  ): string[] {
    const files: string[] = [];

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return files;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const relPath = relative(rootDir, fullPath);

      // Check gitignore matchers
      if (gitignoreMatchers.some((m) => m(relPath))) continue;

      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
        files.push(...this.walkDirectory(fullPath, rootDir, gitignoreMatchers));
      } else if (stat.isFile()) {
        files.push(fullPath);
      }
    }

    return files;
  }

  /**
   * Retrieve all indexed chunks for a file path.
   * Used by tests and the watcher to verify state.
   */
  getChunksForFile(filePath: string) {
    return this.db
      .select()
      .from(ragChunks)
      .where(eq(ragChunks.filePath, filePath))
      .all();
  }

  /**
   * Retrieve all indexed chunks that have an embedding.
   * Used by the RAG search tool.
   *
   * The `embedding IS NOT NULL` filter is applied at the SQL level — filtering
   * in JS after a full-table scan would OOM on large codebases.
   */
  getAllEmbeddedChunks() {
    return this.db
      .select()
      .from(ragChunks)
      .where(isNotNull(ragChunks.embedding))
      .all();
  }
}
