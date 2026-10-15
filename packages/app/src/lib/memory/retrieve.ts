/**
 * retrieve — rank memories for a single chat turn.
 *
 * Two-stage:
 *   1. ALL pinned memories from both tiers (project overrides user happens at
 *      registry load time, so a pinned project memory replacing a pinned user
 *      memory of the same name is already collapsed by the time we see it).
 *   2. Non-pinned candidates scored by a 55/40/5 blend of:
 *        - BM25-lite over (description + body) against the query terms.
 *        - keywordMatch = fraction of query tokens present in description.
 *        - recency boost = exp(-ageDays / 30).
 *      The blend matches the Odysseus hybrid-retrieval default
 *      (see plans/odysseus-competitive-analysis.md §4 Tier 1 row 1.2).
 *
 * Pinned memories are returned first in stable insertion order, then top-K
 * non-pinned in descending score. Empty/whitespace query collapses to
 * "pinned only" — useful at session start before the user types anything.
 *
 * Deterministic and dependency-free. No embeddings, no FTS — Phase C wave 1
 * deliberately ships only the cheap text path. A future wave can add
 * embedding rerank without changing this signature.
 */

import type { IMemoryRegistry, MemoryDef } from './types.js';

export interface RetrieveOpts {
  /** Top-K non-pinned to include. Default 3. */
  topK?: number;
  /** Override `Date.now()` for deterministic tests. */
  nowMs?: number;
}

const DEFAULT_TOP_K = 3;
const RECENCY_HALF_LIFE_DAYS = 30;
const BLEND_BM25 = 0.55;
const BLEND_KEYWORD = 0.4;
const BLEND_RECENCY = 0.05;

// BM25 hyperparameters — standard defaults.
const BM25_K1 = 1.5;
const BM25_B = 0.75;

const TOKEN_RE = /[a-z0-9]+/g;

export function retrieve(
  registry: IMemoryRegistry,
  query: string,
  opts: RetrieveOpts = {},
): MemoryDef[] {
  const all = registry.list();
  const pinned = all.filter((m) => m.pinned);
  const candidates = all.filter((m) => !m.pinned);
  const topK = Math.max(0, opts.topK ?? DEFAULT_TOP_K);
  const nowMs = opts.nowMs ?? Date.now();

  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0 || candidates.length === 0 || topK === 0) {
    return pinned;
  }

  const queryTokens = tokenize(trimmedQuery);
  if (queryTokens.length === 0) return pinned;

  const docs = candidates.map((m) => corpusFor(m));
  const avgDocLen = docs.reduce((a, d) => a + d.length, 0) / Math.max(docs.length, 1);

  // Document frequency for IDF.
  const df = new Map<string, number>();
  for (const tokens of docs) {
    const uniq = new Set(tokens);
    for (const t of uniq) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = docs.length;

  // Score every candidate.
  const scored = candidates.map((mem, i) => {
    const tokens = docs[i] ?? [];
    const bm25Raw = bm25Score(queryTokens, tokens, df, N, avgDocLen);
    const km = keywordMatch(queryTokens, mem.description);
    const recency = recencyBoost(mem, nowMs);
    return { mem, bm25Raw, km, recency };
  });

  // Normalize BM25 to [0, 1] across the candidate pool so the blend is meaningful.
  const maxBm25 = scored.reduce((m, s) => Math.max(m, s.bm25Raw), 0);
  const blend = scored.map((s) => {
    const bm25 = maxBm25 > 0 ? s.bm25Raw / maxBm25 : 0;
    // Recency is a TIEBREAKER, not a standalone signal — a memory must earn at
    // least some textual relevance before it can be surfaced. Otherwise every
    // recently-created memory leaks into every query regardless of topic.
    const textual = bm25 > 0 || s.km > 0;
    const score = textual
      ? BLEND_BM25 * bm25 + BLEND_KEYWORD * s.km + BLEND_RECENCY * s.recency
      : 0;
    return { mem: s.mem, score };
  });

  // Sort desc by score; break ties by createdAt desc (newer first) for determinism.
  blend.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.mem.createdAt ?? '').localeCompare(a.mem.createdAt ?? '');
  });

  const topNonPinned = blend
    .filter((b) => b.score > 0)
    .slice(0, topK)
    .map((b) => b.mem);

  return [...pinned, ...topNonPinned];
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_RE) ?? [];
}

function corpusFor(mem: MemoryDef): string[] {
  const blob = mem.body !== undefined ? `${mem.description} ${mem.body}` : mem.description;
  return tokenize(blob);
}

/** BM25 score for queryTokens against a single document's tokens. */
function bm25Score(
  queryTokens: readonly string[],
  docTokens: readonly string[],
  df: ReadonlyMap<string, number>,
  N: number,
  avgDocLen: number,
): number {
  if (docTokens.length === 0) return 0;
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  let sum = 0;
  for (const qt of queryTokens) {
    const f = tf.get(qt);
    if (f === undefined || f === 0) continue;
    const n = df.get(qt) ?? 0;
    // Standard BM25 IDF; floor at 0 so very common terms don't go negative.
    const idf = Math.max(0, Math.log((N - n + 0.5) / (n + 0.5) + 1));
    const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (docTokens.length / Math.max(avgDocLen, 1)));
    sum += idf * ((f * (BM25_K1 + 1)) / denom);
  }
  return sum;
}

/** Fraction of query tokens present as whole words in the description. */
function keywordMatch(queryTokens: readonly string[], description: string): number {
  if (queryTokens.length === 0) return 0;
  const lower = description.toLowerCase();
  let hits = 0;
  const seen = new Set<string>();
  for (const qt of queryTokens) {
    if (seen.has(qt)) continue;
    seen.add(qt);
    const re = new RegExp(`\\b${escapeRegex(qt)}\\b`, 'i');
    if (re.test(lower)) hits++;
  }
  return hits / seen.size;
}

function recencyBoost(mem: MemoryDef, nowMs: number): number {
  const stamp = mem.lastUsed ?? mem.createdAt;
  if (stamp === undefined || stamp.length === 0) return 0;
  const t = Date.parse(stamp);
  if (Number.isNaN(t)) return 0;
  const ageDays = Math.max(0, (nowMs - t) / (1000 * 60 * 60 * 24));
  return Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
