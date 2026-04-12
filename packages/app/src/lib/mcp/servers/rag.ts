#!/usr/bin/env node
/**
 * uplnk-rag — built-in stdio MCP server for RAG (Retrieval-Augmented Generation).
 *
 * Exposes two tools:
 *   mcp_rag_search  — semantic search over indexed codebase chunks (read-only)
 *   mcp_rag_index   — trigger a full re-index of a directory (write)
 *
 * SECURITY NOTE: This server performs NO path validation. All security
 * validation (allowed-path checking, directory containment) is done by
 * McpManager in the parent process BEFORE forwarding the JSON-RPC call to
 * this child (ref: ADR-004, arch-critical-fixes Phase 4).
 *
 * Running this server directly (outside McpManager) bypasses all security
 * controls — for test/debug purposes only.
 *
 * Embedding config is read from environment variables:
 *   UPLNK_EMBED_BASE_URL  — OpenAI-compatible base URL
 *   UPLNK_EMBED_API_KEY   — API key ('ollama' for local Ollama)
 *   UPLNK_EMBED_MODEL     — embedding model name
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { db } from '@uplnk/db';
import { runMigrations } from '@uplnk/db';
import { Indexer } from '../../rag/indexer.js';
import { createEmbedder, deserializeEmbedding, cosineSimilarity } from '../../rag/embedder.js';

// ─── Bootstrap ────────────────────────────────────────────────────────────────

// Run pending migrations before serving — the RAG child process may be the
// first component to use the DB (e.g. when spawned before the main process
// completes its own runMigrations() call).
try {
  runMigrations();
} catch {
  // Non-fatal: if migrations fail, continue and let individual tool calls fail
}

// ─── Embedder setup ───────────────────────────────────────────────────────────

const embedder = createEmbedder(
  process.env['UPLNK_EMBED_BASE_URL'] !== undefined
    ? {
        baseUrl: process.env['UPLNK_EMBED_BASE_URL'],
        apiKey: process.env['UPLNK_EMBED_API_KEY'] ?? 'ollama',
        model:
          process.env['UPLNK_EMBED_MODEL'] ??
          (process.env['UPLNK_EMBED_BASE_URL']?.includes('openai')
            ? 'text-embedding-3-small'
            : 'nomic-embed-text'),
      }
    : undefined,
);

// ─── Shared indexer instance ──────────────────────────────────────────────────

const indexer = new Indexer(db, embedder);

// ─── MCP server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'uplnk-rag',
  version: '0.1.0',
});

// ─── mcp_rag_search ───────────────────────────────────────────────────────────

server.tool(
  'mcp_rag_search',
  'Semantically search the indexed codebase for chunks relevant to a query. ' +
  'Returns the top-K most similar chunks with their file paths and content. ' +
  'Requires the codebase to have been indexed first via mcp_rag_index.',
  {
    query: z.string().min(1).describe('The search query text'),
    topK: z.number().int().min(1).max(20).optional().describe(
      'Number of results to return (default: 5, max: 20)',
    ),
    directory: z.string().optional().describe(
      'Restrict results to chunks from files under this directory path',
    ),
  },
  async ({
    query,
    topK,
    directory,
  }: {
    query: string;
    topK?: number | undefined;
    directory?: string | undefined;
  }) => {
    const k = topK ?? 5;

    if (embedder === null) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'RAG search requires an embedding model to be configured. ' +
              'Set UPLNK_EMBED_BASE_URL (and optionally UPLNK_EMBED_API_KEY / UPLNK_EMBED_MODEL).',
          },
        ],
        isError: true,
      };
    }

    // Embed the query
    const queryEmbed = await embedder.embed(query);
    if (queryEmbed === null) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Failed to generate query embedding. Is the embedding endpoint reachable?',
          },
        ],
        isError: true,
      };
    }

    // Load all embedded chunks from DB
    const allChunks = indexer.getAllEmbeddedChunks();
    if (allChunks.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No indexed chunks found. Run mcp_rag_index first.',
          },
        ],
      };
    }

    // Filter by directory if specified
    const candidates = directory !== undefined
      ? allChunks.filter((c) => c.filePath.startsWith(directory))
      : allChunks;

    // Score candidates by cosine similarity
    const scored = candidates
      .map((chunk) => {
        if (chunk.embedding === null) return null;
        const vec = deserializeEmbedding(chunk.embedding as Buffer);
        const score = cosineSimilarity(queryEmbed.vector, vec);
        return { chunk, score };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    if (scored.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No results found. Try a different query or re-index the directory.',
          },
        ],
      };
    }

    const resultText = scored
      .map(({ chunk, score }, i) => {
        const pct = (score * 100).toFixed(1);
        return `[${i + 1}] ${chunk.filePath} (chunk ${chunk.chunkIndex}, score: ${pct}%)\n${chunk.content}`;
      })
      .join('\n\n---\n\n');

    return {
      content: [{ type: 'text' as const, text: resultText }],
    };
  },
);

// ─── mcp_rag_index ────────────────────────────────────────────────────────────

server.tool(
  'mcp_rag_index',
  'Index all files under a directory for semantic search. ' +
  'Walks the directory, chunks text files, generates embeddings, and stores them in SQLite. ' +
  'Respects .gitignore patterns and skips binary files. ' +
  'Safe to call multiple times — existing chunks are replaced on re-index.',
  {
    directory: z.string().describe(
      'Absolute path to the directory to index',
    ),
  },
  async ({ directory }: { directory: string }) => {
    try {
      const result = await indexer.indexDirectory(directory);
      const lines = [
        `Indexed ${result.indexed} files, ${result.chunks} chunks, skipped ${result.skipped} files.`,
      ];
      if (result.errors.length > 0) {
        lines.push(`Errors (${result.errors.length}):`);
        for (const err of result.errors.slice(0, 10)) {
          lines.push(`  - ${err}`);
        }
        if (result.errors.length > 10) {
          lines.push(`  ... and ${result.errors.length - 10} more`);
        }
      }
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Indexing failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Start server ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
