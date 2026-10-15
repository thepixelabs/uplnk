/**
 * Runner-only types — kept separate from types.ts because that file is the
 * Wave-1 leaf vocabulary (ExtractedFinding / StopVerdict / ResearchCategory).
 *
 * Runner-internal shapes that compose those leaves (the multi-round plan,
 * the per-round query plan, the configured options and emitted events) live
 * here so the leaf file stays small and shareable.
 *
 * No imports from runner.ts to avoid a cycle: runner.ts depends on this file.
 */

import type { LanguageModel } from 'ai';
import type { ResearchCategory, ExtractedFinding } from './types.js';
import type { SearchProvider } from '../search/index.js';

/** Plan returned by the initial planning micro-call. */
export interface ResearchPlan {
  /** Sub-questions the runner should make sure to cover. */
  subQuestions: string[];
  /** Salient topics / entities to anchor query generation. */
  keyTopics: string[];
  /** One-line definition of "done" the synthesizer references. */
  successCriterion: string;
}

/** Output of the per-round query-generation micro-call. */
export interface QueryPlan {
  queries: string[];
}

/** Configuration accepted by runResearch. */
export interface ResearchRunOptions {
  /** The user's original research query. */
  query: string;
  /** Model used for plan, query-gen, extraction, synthesis, stop-criterion, final report. */
  model: LanguageModel;
  /** Optional separate model for cheap micro-calls (classify, stop). Defaults to `model`. */
  microCallModel?: LanguageModel;
  /** Search backend(s). */
  search: SearchProvider;
  /** Max rounds before forcing a stop. Default 5. */
  maxRounds?: number;
  /** Max wall-clock ms for the whole run. Default 300_000. */
  maxWallMs?: number;
  /** Per-source content character cap before extraction. Default 15000. */
  maxContentChars?: number;
  /** Concurrent extraction limit (per-round semaphore). Default 3. */
  extractionConcurrency?: number;
  /** Sliding window of findings used in synthesis prompt. Default 10. */
  synthesisWindow?: number;
  /** Aborts the entire run. */
  signal?: AbortSignal;
  /** Force a specific category instead of auto-classify. */
  category?: ResearchCategory;
  /** Domain include/exclude propagated to search. */
  includeDomains?: readonly string[];
  excludeDomains?: readonly string[];
}

/** Events emitted by the runner generator. */
export type ResearchEvent =
  | { type: 'plan:start' }
  | { type: 'plan:done'; category: ResearchCategory; planSummary: string }
  | { type: 'round:start'; round: number; queries: readonly string[] }
  | { type: 'search:result'; round: number; query: string; resultCount: number }
  | { type: 'extract:start'; round: number; sourceUrl: string }
  | { type: 'extract:done'; round: number; sourceUrl: string; confidence: number }
  | { type: 'synthesize:start'; round: number }
  | { type: 'synthesize:done'; round: number; reportLength: number }
  | { type: 'stop:check'; round: number; verdict: { stop: boolean; reason: string } }
  | { type: 'round:end'; round: number; durationMs: number; newFindingsCount: number }
  | { type: 'final:start' }
  | { type: 'final:delta'; delta: string }
  | { type: 'final:done'; report: string; sources: readonly string[]; durationMs: number }
  | { type: 'error'; phase: string; message: string }
  | { type: 'aborted'; reason: string };

/** Final value returned by the runResearch generator. */
export interface ResearchResult {
  /** Final Markdown report with inline citations. */
  report: string;
  /** Deduplicated source URLs used. */
  sources: string[];
  /** Detected/forced category. */
  category: ResearchCategory;
  /** Total rounds executed. */
  rounds: number;
  durationMs: number;
}

/**
 * Internal — a finding plus the URL it came from. The runner keeps these in
 * one flat array, then derives `sources[]` for the final report by deduping
 * `.url` values in insertion order.
 */
export interface CitedFinding extends ExtractedFinding {
  url: string;
  round: number;
}
