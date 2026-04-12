/**
 * embedder.ts — local embedding generation for RAG.
 *
 * Generates vector embeddings from text using an Ollama/OpenAI-compatible
 * embeddings endpoint. The embedding model is configurable:
 *   - Ollama default: nomic-embed-text
 *   - OpenAI-compatible default: text-embedding-3-small
 *
 * Falls back gracefully (returns null) when no embedding config is available
 * or the endpoint is unreachable.
 *
 * Embedding dimensions are NOT hard-coded — they depend on the model and are
 * stored alongside the embedding BLOB so code always reads dimension from data.
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface EmbedderConfig {
  /** Base URL of the OpenAI-compatible endpoint (e.g. http://localhost:11434/v1) */
  baseUrl: string;
  /** API key — use 'ollama' for local Ollama, real key for OpenAI/hosted */
  apiKey: string;
  /** Embedding model name */
  model: string;
}

export interface EmbedResult {
  /** Float32Array of embedding values */
  vector: Float32Array;
  /** Number of dimensions (= vector.length) */
  dimensions: number;
}

// ─── Serialize / Deserialize ───────────────────────────────────────────────────

/**
 * Serialise a Float32Array to a Buffer (little-endian IEEE 754) for SQLite BLOB storage.
 */
export function serializeEmbedding(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * Deserialise a BLOB (Buffer / Uint8Array) back into a Float32Array.
 */
export function deserializeEmbedding(blob: Buffer | Uint8Array): Float32Array {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  // Float32Array needs 4-byte alignment — copy into a fresh ArrayBuffer to guarantee it
  const aligned = new ArrayBuffer(buf.byteLength);
  buf.copy(Buffer.from(aligned));
  return new Float32Array(aligned);
}

// ─── Cosine similarity ─────────────────────────────────────────────────────────

/**
 * Compute cosine similarity between two Float32Arrays of equal length.
 * Returns a value in [-1, 1]. Returns 0 for zero-length or mismatched arrays.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

// ─── Embedder class ────────────────────────────────────────────────────────────

export class Embedder {
  private readonly config: EmbedderConfig;

  constructor(config: EmbedderConfig) {
    this.config = config;
  }

  /**
   * Generate an embedding for the given text.
   *
   * Returns null (rather than throwing) when the embedding endpoint is
   * unreachable, misconfigured, or returns an unexpected response. This
   * keeps the indexer resilient — files that fail to embed are skipped, not
   * crash the whole index operation.
   */
  async embed(text: string): Promise<EmbedResult | null> {
    if (text.trim().length === 0) return null;

    const url = `${this.config.baseUrl.replace(/\/$/, '')}/embeddings`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          input: text,
        }),
        signal: AbortSignal.timeout(30_000), // 30 s timeout
      });
    } catch {
      // Network error or timeout — graceful fallback
      return null;
    }

    if (!response.ok) {
      return null;
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return null;
    }

    // OpenAI embedding response shape:
    // { data: [{ embedding: number[] }] }
    if (
      typeof data !== 'object' ||
      data === null ||
      !('data' in data) ||
      !Array.isArray((data as { data: unknown }).data) ||
      (data as { data: unknown[] }).data.length === 0
    ) {
      return null;
    }

    const first = (data as { data: unknown[] }).data[0];
    if (
      typeof first !== 'object' ||
      first === null ||
      !('embedding' in first) ||
      !Array.isArray((first as { embedding: unknown }).embedding)
    ) {
      return null;
    }

    const rawEmbedding = (first as { embedding: number[] }).embedding;
    if (rawEmbedding.length === 0) return null;

    const vector = new Float32Array(rawEmbedding);
    return { vector, dimensions: vector.length };
  }

  /**
   * Embed multiple texts in sequence. Texts that fail to embed are returned as
   * null entries — the caller decides whether to skip or abort.
   */
  async embedBatch(texts: string[]): Promise<Array<EmbedResult | null>> {
    const results: Array<EmbedResult | null> = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create an Embedder from an optional config object.
 * Returns null when config is undefined so callers can check before indexing.
 */
export function createEmbedder(config?: EmbedderConfig | undefined): Embedder | null {
  if (config === undefined) return null;
  return new Embedder(config);
}
