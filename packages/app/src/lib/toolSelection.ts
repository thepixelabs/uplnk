/**
 * toolSelection — pick a small, relevant subset of the available tools to send
 * with the next LLM call.
 *
 * Background: uplnk's tool registry grows every time a new MCP server connects.
 * A local 4k-context model can't afford to receive 30+ tool schemas every turn
 * (each one is 100–500 tokens). The competitive analysis prescribes BM25 over
 * the tool name + description corpus to keep the top-K most relevant tools per
 * turn — no embeddings, no extra deps, deterministic for testing.
 *
 * See plans/odysseus-competitive-analysis.md §4 Tier 1 row 1.3 and §7.
 *
 * Approach:
 *   1. Build a per-tool "document" = name (twice, as a cheap weight boost) +
 *      description. Tokenize lowercase, split on non-[a-z0-9_], drop tokens
 *      shorter than 2 chars and common English stopwords.
 *   2. Compute corpus statistics (N, df per term, avgDocLen).
 *   3. Score each tool against the user message with BM25 (k1=1.2, b=0.75).
 *   4. Assemble the final set deterministically: alwaysAvailable → keyword-forced
 *      → top-K by score (ties broken by tool name). Dedup while preserving
 *      order so the alwaysAvailable / forced sets win on collision.
 *
 * The exported `scoreTool` is a corpus-free per-doc match strength (tf-saturation
 * with idf=1). It's for telemetry — same inputs → same output, no global state.
 */

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * Name appears this many times in its document. Description appears once.
 * Two is the cheapest boost that meaningfully reorders ties; higher values
 * over-anchor on the name and miss good description matches.
 */
const NAME_REPEAT = 2;

/**
 * Common English stopwords. Kept tiny on purpose — tool descriptions are short
 * and removing real query words is worse than tolerating a few noise hits.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'a',
  'an',
  'of',
  'to',
  'for',
  'with',
  'in',
  'on',
  'at',
  'by',
  'is',
  'are',
  'this',
  'that',
  'what',
  'how',
  'when',
  'where',
]);

const DEFAULT_TOP_K = 8;

const TOKEN_SPLIT = /[^a-z0-9_]+/;

/**
 * Lowercase, split on non-alphanumeric/underscore, drop short tokens and
 * stopwords. Pure: same input → same output, never throws on any string.
 */
function tokenize(text: string): string[] {
  if (text.length === 0) return [];
  const lowered = text.toLowerCase();
  const parts = lowered.split(TOKEN_SPLIT);
  const out: string[] = [];
  for (const part of parts) {
    if (part.length < 2) continue;
    if (STOPWORDS.has(part)) continue;
    out.push(part);
  }
  return out;
}

function buildDocText(name: string, description: string): string {
  const repeated = `${name} `.repeat(NAME_REPEAT);
  return description.length === 0 ? repeated.trim() : `${repeated}${description}`;
}

/**
 * Standard BM25 idf with the +1 smoothing variant — never negative even when
 * a term appears in every document (df === N).
 */
function bm25Idf(n: number, df: number): number {
  return Math.log((n - df + 0.5) / (df + 0.5) + 1);
}

interface CorpusDoc {
  name: string;
  tokens: string[];
  tf: Map<string, number>;
  len: number;
}

function termFrequencies(tokens: readonly string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const tok of tokens) {
    tf.set(tok, (tf.get(tok) ?? 0) + 1);
  }
  return tf;
}

interface Corpus {
  docs: CorpusDoc[];
  df: Map<string, number>;
  avgDocLen: number;
}

function buildCorpus(tools: Record<string, { description: string }>): Corpus {
  const names = Object.keys(tools);
  const docs: CorpusDoc[] = [];
  const df = new Map<string, number>();
  let totalLen = 0;

  for (const name of names) {
    const description = tools[name]!.description;
    const tokens = tokenize(buildDocText(name, description));
    const tf = termFrequencies(tokens);
    docs.push({ name, tokens, tf, len: tokens.length });
    totalLen += tokens.length;
    // df is incremented per UNIQUE term in this doc.
    for (const term of tf.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const avgDocLen = docs.length === 0 ? 0 : totalLen / docs.length;
  return { docs, df, avgDocLen };
}

function bm25Score(
  queryTerms: readonly string[],
  doc: CorpusDoc,
  corpus: Corpus,
): number {
  if (queryTerms.length === 0) return 0;
  const n = corpus.docs.length;
  const avg = corpus.avgDocLen;
  let score = 0;
  // Avoid divide-by-zero on a single-tool corpus where avg might be 0.
  const safeAvg = avg > 0 ? avg : 1;
  for (const term of queryTerms) {
    const tf = doc.tf.get(term) ?? 0;
    if (tf === 0) continue;
    const df = corpus.df.get(term) ?? 0;
    const idf = bm25Idf(n, df);
    const numerator = tf * (BM25_K1 + 1);
    const denominator = tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.len) / safeAvg);
    score += idf * (numerator / denominator);
  }
  return score;
}

export interface ToolSelectionInput {
  userMessage: string;
  /** Full tool registry — key = tool name, value = description string. */
  tools: Record<string, { description: string }>;
  /** Tools that must always be included regardless of score. */
  alwaysAvailable?: readonly string[];
  /**
   * Keyword → tool-names map. If any keyword matches userMessage (case-
   * insensitive, word-boundary), the mapped tools are force-included.
   */
  keywordHints?: Record<string, readonly string[]>;
  /** Max tools to return (excluding alwaysAvailable + keyword-forced). Default 8. */
  topK?: number;
}

export interface ToolSelectionResult {
  /**
   * Names of selected tools, in deterministic order: alwaysAvailable first
   * (input order), then keyword-forced (keyword-input order), then top-K by
   * descending score (ties broken by tool name ascending). Deduped.
   */
  selected: string[];
  /** Per-tool scores for selected tools (for debug/telemetry). */
  scores: Record<string, number>;
}

/**
 * Word-boundary, case-insensitive substring match — keyword hints are
 * authored as plain English so we match them the way a human reads them.
 * "search" matches "search the web" and "Search!" but not "researching".
 */
function keywordMatches(message: string, keyword: string): boolean {
  if (keyword.length === 0) return false;
  // Lowercase both sides so the regex itself doesn't need the /i flag,
  // and so we don't compile a fresh RegExp per call site.
  const lowerMsg = message.toLowerCase();
  const lowerKw = keyword.toLowerCase();
  // Escape regex metacharacters in the keyword so a user-supplied hint like
  // "C++" or "node.js" can't blow up the matcher.
  const escaped = lowerKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // \b only handles ASCII word chars; for keywords that begin/end with a
  // non-word char (e.g. "C++") the \b would never anchor — use a manual
  // boundary that accepts start/end-of-string or any non-alphanumeric.
  const re = new RegExp(`(^|[^a-z0-9_])${escaped}($|[^a-z0-9_])`);
  return re.test(lowerMsg);
}

/**
 * Pure per-doc match strength against `query`. Corpus-free (idf=1, b cancels),
 * so the returned number is comparable across calls with the SAME query and
 * different (name, description) pairs — not across different queries.
 *
 * Exposed for telemetry and unit tests; the main path uses the corpus-aware
 * BM25 inside `selectTools`.
 */
export function scoreTool(query: string, name: string, description: string): number {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return 0;
  const docTokens = tokenize(buildDocText(name, description));
  if (docTokens.length === 0) return 0;
  const tf = termFrequencies(docTokens);
  let score = 0;
  for (const term of queryTerms) {
    const t = tf.get(term) ?? 0;
    if (t === 0) continue;
    score += (t * (BM25_K1 + 1)) / (t + BM25_K1);
  }
  return score;
}

interface ScoredTool {
  name: string;
  score: number;
}

/**
 * Stable sort: descending score, ties broken by name ascending. Used for
 * top-K — two tools with the same BM25 score must land in the same order
 * across runs for determinism.
 */
function compareScored(a: ScoredTool, b: ScoredTool): number {
  if (a.score !== b.score) return b.score - a.score;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function selectTools(input: ToolSelectionInput): ToolSelectionResult {
  const { userMessage, tools } = input;
  const alwaysAvailable = input.alwaysAvailable ?? [];
  const keywordHints = input.keywordHints ?? {};
  const topK = input.topK ?? DEFAULT_TOP_K;

  // Fast path — no tools to choose from.
  const toolNames = Object.keys(tools);
  if (toolNames.length === 0) {
    return { selected: [], scores: {} };
  }

  const selected: string[] = [];
  const scores: Record<string, number> = {};
  const seen = new Set<string>();

  // 1) alwaysAvailable, in input order, skipping any name not in `tools`.
  for (const name of alwaysAvailable) {
    if (!(name in tools)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    selected.push(name);
    scores[name] = 0;
  }

  // 2) Keyword-forced — iterate in keyword-input order so a deterministic
  //    Record key order yields a deterministic selection order. Within a
  //    single matching keyword, preserve the input order of the tool list.
  for (const keyword of Object.keys(keywordHints)) {
    if (!keywordMatches(userMessage, keyword)) continue;
    for (const name of keywordHints[keyword]!) {
      if (!(name in tools)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      selected.push(name);
      scores[name] = 0;
    }
  }

  // 3) Top-K by BM25 score — only candidates not yet selected, only when
  //    there is something to score against (non-empty user message) and at
  //    least one slot to fill.
  if (topK > 0 && userMessage.trim().length > 0) {
    const queryTerms = tokenize(userMessage);
    if (queryTerms.length > 0) {
      const corpus = buildCorpus(tools);
      const candidates: ScoredTool[] = [];
      for (const doc of corpus.docs) {
        if (seen.has(doc.name)) continue;
        const s = bm25Score(queryTerms, doc, corpus);
        if (s > 0) candidates.push({ name: doc.name, score: s });
      }
      candidates.sort(compareScored);
      const take = Math.min(topK, candidates.length);
      for (let i = 0; i < take; i++) {
        const { name, score } = candidates[i]!;
        seen.add(name);
        selected.push(name);
        scores[name] = score;
      }
    }
  }

  return { selected, scores };
}
