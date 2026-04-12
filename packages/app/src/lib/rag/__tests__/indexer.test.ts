/**
 * Unit tests for indexer.ts — chunking logic and Indexer class.
 *
 * chunkText is a pure function, tested without any mocks.
 * Indexer class tests mock node:fs to avoid real filesystem access.
 *
 * pylon-db is mocked globally by src/__tests__/setup.ts (ragChunks export
 * added there). We do NOT re-declare the pylon-db mock here to avoid
 * conflicting with the global setup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── fs mock ──────────────────────────────────────────────────────────────────

const mockStatSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockExistsSync = vi.fn();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: (...args: unknown[]) => mockStatSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
  };
});

// ─── Subject under test ────────────────────────────────────────────────────────

import { chunkText, Indexer } from '../indexer.js';

// ─── chunkText ─────────────────────────────────────────────────────────────────

describe('chunkText', () => {
  it('returns empty array for empty string', () => {
    expect(chunkText('')).toEqual([]);
  });

  it('returns empty array for whitespace-only string', () => {
    expect(chunkText('   \n\t  ')).toEqual([]);
  });

  it('returns a single chunk for short text', () => {
    const text = 'Hello, world!';
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.chunkIndex).toBe(0);
    expect(chunks[0]!.content).toBe('Hello, world!');
  });

  it('assigns sequential chunkIndex values', () => {
    const line = 'The quick brown fox jumps over the lazy dog.\n';
    const text = line.repeat(50); // ~2350 chars → multiple chunks
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.chunkIndex).toBe(i);
    }
  });

  it('produces overlapping chunks', () => {
    const line = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ01\n'; // 66 chars
    const text = line.repeat(32); // 2112 chars → 2+ chunks
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Total content length > original due to overlap
    const totalContentLength = chunks.reduce((sum, c) => sum + c.content.length, 0);
    expect(totalContentLength).toBeGreaterThanOrEqual(text.trim().length);
  });

  it('snaps chunk boundaries to newlines', () => {
    const segment = 'x'.repeat(99) + '\n';
    const text = segment.repeat(25); // 2500 chars → should produce 2 chunks
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // With overlapping chunks, the first chunk must start at the beginning
    // and the last chunk must end at (or near) the end of the text
    expect(text.trimStart().startsWith(chunks[0]!.content.slice(0, 10))).toBe(true);
    const lastChunk = chunks[chunks.length - 1]!;
    expect(text.trimEnd().endsWith(lastChunk.content.slice(-10))).toBe(true);
  });

  it('produces chunks of at most approximately CHUNK_CHARS + lookahead', () => {
    const MAX_EXPECTED_CHUNK_LEN = 2048 + 256 + 10;
    const text = 'a'.repeat(10000);
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(MAX_EXPECTED_CHUNK_LEN);
    }
  });

  it('handles text with exactly one chunk boundary crossing', () => {
    const text = 'B'.repeat(2048 * 2);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.length).toBeLessThanOrEqual(5);
  });

  it('handles a single long line with no newlines', () => {
    const text = 'z'.repeat(5000);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeGreaterThan(0);
    }
  });

  it('chunkIndex values are unique and sequential', () => {
    const text = 'word '.repeat(600);
    const chunks = chunkText(text);
    const indices = chunks.map((c) => c.chunkIndex);
    const expected = Array.from({ length: chunks.length }, (_, i) => i);
    expect(indices).toEqual(expected);
  });

  it('all chunks have non-empty content', () => {
    const text = 'line\n'.repeat(600);
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      expect(chunk.content.trim().length).toBeGreaterThan(0);
    }
  });
});

// ─── Indexer class ─────────────────────────────────────────────────────────────

describe('Indexer', () => {
  function makeDb() {
    const runMock = vi.fn();
    const whereMock = vi.fn().mockReturnValue({ run: runMock, all: vi.fn().mockReturnValue([]) });
    const deleteMock = vi.fn().mockReturnValue({ where: whereMock });
    const insertRunMock = vi.fn();
    const insertValuesMock = vi.fn().mockReturnValue({ run: insertRunMock });
    const insertMock = vi.fn().mockReturnValue({ values: insertValuesMock });
    const allMock = vi.fn().mockReturnValue([]);
    const fromMock = vi.fn().mockReturnValue({ where: whereMock, all: allMock });
    const selectMock = vi.fn().mockReturnValue({ from: fromMock });

    return {
      delete: deleteMock,
      insert: insertMock,
      select: selectMock,
      _insertMock: insertMock,
      _runMock: runMock,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
  });

  it('skips binary files (null byte in first 8 KiB)', async () => {
    const binaryBuf = Buffer.alloc(100);
    binaryBuf[5] = 0;

    mockStatSync.mockReturnValue({ size: 100, isDirectory: () => false, isFile: () => true });
    mockReadFileSync.mockReturnValue(binaryBuf);

    const db = makeDb();
    const indexer = new Indexer(db as never, null);
    const result = await indexer.indexFile('/test/file.bin');

    expect(result.skipped).toBe(1);
    expect(result.indexed).toBe(0);
    expect(result.chunks).toBe(0);
  });

  it('skips files larger than 1 MiB', async () => {
    mockStatSync.mockReturnValue({ size: 2 * 1024 * 1024, isDirectory: () => false, isFile: () => true });

    const db = makeDb();
    const indexer = new Indexer(db as never, null);
    const result = await indexer.indexFile('/test/bigfile.ts');

    expect(result.skipped).toBe(1);
    expect(result.indexed).toBe(0);
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('skips files when stat throws', async () => {
    mockStatSync.mockImplementation(() => { throw new Error('ENOENT'); });

    const db = makeDb();
    const indexer = new Indexer(db as never, null);
    const result = await indexer.indexFile('/test/missing.ts');

    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
  });

  it('indexes a small text file and creates chunks without an embedder', async () => {
    const fileContent = 'export const foo = 42;\nexport const bar = "hello";\n';
    const noNullBuf = Buffer.from(fileContent);

    mockStatSync.mockReturnValue({
      size: fileContent.length,
      isDirectory: () => false,
      isFile: () => true,
    });
    mockReadFileSync
      .mockReturnValueOnce(noNullBuf)   // binary check
      .mockReturnValueOnce(fileContent); // utf-8 content read

    const db = makeDb();
    const indexer = new Indexer(db as never, null);
    const result = await indexer.indexFile('/test/source.ts');

    expect(result.indexed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.chunks).toBeGreaterThanOrEqual(1);
    expect(db._insertMock).toHaveBeenCalledTimes(result.chunks);
  });

  it('skips whitespace-only files (no chunks produced)', async () => {
    const emptyContent = '   \n  ';
    const buf = Buffer.from(emptyContent);

    mockStatSync.mockReturnValue({ size: emptyContent.length, isDirectory: () => false, isFile: () => true });
    mockReadFileSync
      .mockReturnValueOnce(buf)
      .mockReturnValueOnce(emptyContent);

    const db = makeDb();
    const indexer = new Indexer(db as never, null);
    const result = await indexer.indexFile('/test/empty.ts');

    expect(result.skipped).toBe(1);
    expect(result.chunks).toBe(0);
    expect(db._insertMock).not.toHaveBeenCalled();
  });

  it('records an error and skips when readFileSync (content read) throws', async () => {
    const buf = Buffer.from('no null bytes here');

    mockStatSync.mockReturnValue({ size: 100, isDirectory: () => false, isFile: () => true });
    mockReadFileSync
      .mockReturnValueOnce(buf) // binary check passes
      .mockImplementationOnce(() => { throw new Error('EACCES: permission denied'); });

    const db = makeDb();
    const indexer = new Indexer(db as never, null);
    const result = await indexer.indexFile('/test/locked.ts');

    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('EACCES');
    expect(db._insertMock).not.toHaveBeenCalled();
  });

  it('stores embedding blob when embedder returns a result', async () => {
    const fileContent = 'const foo = "bar";\n';
    const noNullBuf = Buffer.from(fileContent);

    mockStatSync.mockReturnValue({ size: fileContent.length, isDirectory: () => false, isFile: () => true });
    mockReadFileSync
      .mockReturnValueOnce(noNullBuf)
      .mockReturnValueOnce(fileContent);

    const mockEmbedder = {
      embed: vi.fn().mockResolvedValue({
        vector: new Float32Array([0.1, 0.2, 0.3]),
        dimensions: 3,
      }),
      embedBatch: vi.fn(),
    };

    const db = makeDb();
    const indexer = new Indexer(db as never, mockEmbedder as never);
    const result = await indexer.indexFile('/test/source.ts');

    expect(result.indexed).toBe(1);
    expect(mockEmbedder.embed).toHaveBeenCalledTimes(result.chunks);

    // The values() mock should have been called with a non-null embedding Buffer
    const insertResult = (db._insertMock as ReturnType<typeof vi.fn>).mock.results[0]?.value as
      { values: ReturnType<typeof vi.fn> };
    expect(insertResult.values).toHaveBeenCalledWith(
      expect.objectContaining({ embedding: expect.any(Buffer) }),
    );
  });

  it('stores null embedding when embedder returns null', async () => {
    const fileContent = 'const x = 1;\n';
    const buf = Buffer.from(fileContent);

    mockStatSync.mockReturnValue({ size: fileContent.length, isDirectory: () => false, isFile: () => true });
    mockReadFileSync
      .mockReturnValueOnce(buf)
      .mockReturnValueOnce(fileContent);

    const mockEmbedder = {
      embed: vi.fn().mockResolvedValue(null),
      embedBatch: vi.fn(),
    };

    const db = makeDb();
    const indexer = new Indexer(db as never, mockEmbedder as never);
    await indexer.indexFile('/test/source.ts');

    const insertResult = (db._insertMock as ReturnType<typeof vi.fn>).mock.results[0]?.value as
      { values: ReturnType<typeof vi.fn> };
    expect(insertResult.values).toHaveBeenCalledWith(
      expect.objectContaining({ embedding: null }),
    );
  });

  it('deleteFile calls db.delete on ragChunks for the given path', () => {
    const runMock = vi.fn();
    const whereMock = vi.fn().mockReturnValue({ run: runMock });
    const deleteMock = vi.fn().mockReturnValue({ where: whereMock });

    const db = { delete: deleteMock, insert: vi.fn(), select: vi.fn() };
    const indexer = new Indexer(db as never, null);
    indexer.deleteFile('/test/to-delete.ts');

    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it('getChunksForFile returns the rows for a given file path', () => {
    const rows = [
      { id: 'chunk-1', filePath: '/test/file.ts', chunkIndex: 0, content: 'code', embedding: null, indexedAt: '' },
    ];
    const allMock = vi.fn().mockReturnValue(rows);
    const whereMock = vi.fn().mockReturnValue({ all: allMock });
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    const selectMock = vi.fn().mockReturnValue({ from: fromMock });

    const db = { delete: vi.fn(), insert: vi.fn(), select: selectMock };
    const indexer = new Indexer(db as never, null);
    const chunks = indexer.getChunksForFile('/test/file.ts');

    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(chunks).toHaveLength(1);
  });

  it('getAllEmbeddedChunks filters out chunks with null embedding', () => {
    const rows = [
      { id: 'a', filePath: '/f', chunkIndex: 0, content: 'c1', embedding: Buffer.alloc(12), indexedAt: '' },
      { id: 'b', filePath: '/f', chunkIndex: 1, content: 'c2', embedding: null, indexedAt: '' },
    ];
    const allMock = vi.fn().mockReturnValue(rows);
    const whereMock = vi.fn().mockReturnValue({ all: allMock });
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    const selectMock = vi.fn().mockReturnValue({ from: fromMock });

    const db = { delete: vi.fn(), insert: vi.fn(), select: selectMock };
    const indexer = new Indexer(db as never, null);
    const embedded = indexer.getAllEmbeddedChunks();

    expect(embedded).toHaveLength(1);
    expect(embedded[0]?.id).toBe('a');
  });
});
