/**
 * Unit tests for embedder.ts
 *
 * Validates:
 * - Graceful fallback when no config is provided (createEmbedder returns null)
 * - Graceful fallback when embedding endpoint is unreachable (returns null)
 * - Correct parsing of a valid embedding response
 * - cosineSimilarity correctness on known vectors
 * - serializeEmbedding / deserializeEmbedding roundtrip
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createEmbedder,
  Embedder,
  cosineSimilarity,
  serializeEmbedding,
  deserializeEmbedding,
} from '../embedder.js';

// ─── createEmbedder ─────────────────────────────────────────────────────────────

describe('createEmbedder', () => {
  it('returns null when config is undefined', () => {
    expect(createEmbedder(undefined)).toBeNull();
  });

  it('returns an Embedder instance when config is provided', () => {
    const embedder = createEmbedder({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'nomic-embed-text',
    });
    expect(embedder).toBeInstanceOf(Embedder);
  });
});

// ─── Embedder.embed ─────────────────────────────────────────────────────────────

describe('Embedder.embed', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null for empty text', async () => {
    const embedder = new Embedder({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'nomic-embed-text',
    });
    const result = await embedder.embed('   ');
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns null when fetch throws (endpoint unreachable)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const embedder = new Embedder({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'nomic-embed-text',
    });
    const result = await embedder.embed('hello world');
    expect(result).toBeNull();
  });

  it('returns null when response is not ok', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });
    const embedder = new Embedder({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'nomic-embed-text',
    });
    const result = await embedder.embed('hello world');
    expect(result).toBeNull();
  });

  it('returns null when response JSON is malformed', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ wrong: 'shape' }),
    });
    const embedder = new Embedder({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'nomic-embed-text',
    });
    const result = await embedder.embed('hello world');
    expect(result).toBeNull();
  });

  it('returns an EmbedResult with correct dimensions on success', async () => {
    const mockEmbedding = [0.1, 0.2, 0.3, 0.4, 0.5];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        data: [{ embedding: mockEmbedding }],
      }),
    });
    const embedder = new Embedder({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'nomic-embed-text',
    });
    const result = await embedder.embed('hello world');
    expect(result).not.toBeNull();
    expect(result!.dimensions).toBe(5);
    expect(result!.vector).toBeInstanceOf(Float32Array);
    expect(result!.vector.length).toBe(5);
    // Values should be close to the input (within float32 precision)
    for (let i = 0; i < mockEmbedding.length; i++) {
      expect(result!.vector[i]).toBeCloseTo(mockEmbedding[i]!, 5);
    }
  });

  it('calls the correct endpoint URL', async () => {
    const mockEmbedding = [1, 2, 3];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [{ embedding: mockEmbedding }] }),
    });
    const embedder = new Embedder({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'test-key',
      model: 'nomic-embed-text',
    });
    await embedder.embed('test');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
        }),
      }),
    );
  });

  it('strips trailing slash from baseUrl before appending /embeddings', async () => {
    const mockEmbedding = [1, 2, 3];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [{ embedding: mockEmbedding }] }),
    });
    const embedder = new Embedder({
      baseUrl: 'http://localhost:11434/v1/',  // trailing slash
      apiKey: 'ollama',
      model: 'nomic-embed-text',
    });
    await embedder.embed('test');
    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe('http://localhost:11434/v1/embeddings');
  });

  it('returns null when response.json() throws', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
    });
    const embedder = new Embedder({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'nomic-embed-text',
    });
    const result = await embedder.embed('hello world');
    expect(result).toBeNull();
  });

  it('returns null when data array is empty', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });
    const embedder = new Embedder({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'nomic-embed-text',
    });
    const result = await embedder.embed('hello world');
    expect(result).toBeNull();
  });

  it('returns null when first data item has no embedding field', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [{ object: 'embedding' }] }),
    });
    const embedder = new Embedder({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'nomic-embed-text',
    });
    const result = await embedder.embed('hello world');
    expect(result).toBeNull();
  });

  it('returns null when embedding array is empty', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [{ embedding: [] }] }),
    });
    const embedder = new Embedder({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'nomic-embed-text',
    });
    const result = await embedder.embed('hello world');
    expect(result).toBeNull();
  });
});

// ─── cosineSimilarity ──────────────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('returns -1 for opposite vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity(new Float32Array([]), new Float32Array([]))).toBe(0);
  });

  it('returns 0 for mismatched dimensions', () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('returns 0 for zero vectors', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([0, 0, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

// ─── Embedder.embedBatch ───────────────────────────────────────────────────────

describe('Embedder.embedBatch', () => {
  const mockFetchBatch = vi.fn();

  beforeEach(() => {
    mockFetchBatch.mockReset();
    vi.stubGlobal('fetch', mockFetchBatch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns an array of results matching the input length', async () => {
    const embedding = [0.1, 0.2, 0.3];
    mockFetchBatch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ embedding }] }),
    });

    const embedder = new Embedder({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'nomic-embed-text',
    });

    const results = await embedder.embedBatch(['text one', 'text two', 'text three']);
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result).not.toBeNull();
      expect(result!.dimensions).toBe(3);
    }
  });

  it('returns null entries for texts that fail to embed', async () => {
    mockFetchBatch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [{ embedding: [1, 2, 3] }] }),
      })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    const embedder = new Embedder({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'nomic-embed-text',
    });

    const results = await embedder.embedBatch(['good text', 'bad text']);
    expect(results[0]).not.toBeNull();
    expect(results[1]).toBeNull();
  });

  it('returns empty array for empty input without calling fetch', async () => {
    const embedder = new Embedder({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'nomic-embed-text',
    });
    const results = await embedder.embedBatch([]);
    expect(results).toEqual([]);
    expect(mockFetchBatch).not.toHaveBeenCalled();
  });

  it('calls fetch once per non-empty text', async () => {
    const embedding = [0.5, 0.5];
    mockFetchBatch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ embedding }] }),
    });

    const embedder = new Embedder({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'nomic-embed-text',
    });

    await embedder.embedBatch(['a', 'b', 'c']);
    expect(mockFetchBatch).toHaveBeenCalledTimes(3);
  });

  it('skips empty strings and returns null for them', async () => {
    mockFetchBatch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ embedding: [1] }] }),
    });

    const embedder = new Embedder({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'nomic-embed-text',
    });

    const results = await embedder.embedBatch(['valid', '   ', 'also valid']);
    // Empty string returns null (embed() returns null for empty text)
    expect(results[0]).not.toBeNull();
    expect(results[1]).toBeNull();
    expect(results[2]).not.toBeNull();
    // Only 2 fetch calls (empty text is short-circuited in embed())
    expect(mockFetchBatch).toHaveBeenCalledTimes(2);
  });
});

// ─── serialize / deserialize roundtrip ────────────────────────────────────────

describe('serializeEmbedding / deserializeEmbedding', () => {
  it('roundtrips a Float32Array through Buffer', () => {
    const original = new Float32Array([0.1, -0.5, 1.23456789, 0.0, 100.0]);
    const blob = serializeEmbedding(original);
    expect(blob).toBeInstanceOf(Buffer);
    expect(blob.byteLength).toBe(original.byteLength);

    const restored = deserializeEmbedding(blob);
    expect(restored).toBeInstanceOf(Float32Array);
    expect(restored.length).toBe(original.length);

    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i]!, 5);
    }
  });

  it('roundtrips a Uint8Array (as returned by SQLite blob column)', () => {
    const original = new Float32Array([1.0, 2.0, 3.0]);
    const buf = serializeEmbedding(original);
    // Simulate SQLite returning a Uint8Array
    const uint8 = new Uint8Array(buf);
    const restored = deserializeEmbedding(uint8);
    expect(restored.length).toBe(3);
    expect(restored[0]).toBeCloseTo(1.0, 5);
    expect(restored[1]).toBeCloseTo(2.0, 5);
    expect(restored[2]).toBeCloseTo(3.0, 5);
  });

  it('handles empty embedding', () => {
    const original = new Float32Array([]);
    const blob = serializeEmbedding(original);
    expect(blob.byteLength).toBe(0);
    const restored = deserializeEmbedding(blob);
    expect(restored.length).toBe(0);
  });
});
