/**
 * Shared types for the Deep Research package.
 *
 * Three concerns share a vocabulary here:
 *   - extractor.ts emits ExtractedFinding per source.
 *   - stopCriterion.ts emits StopVerdict per round.
 *   - categories.ts maps the user's query to a ResearchCategory whose
 *     downstream effect is to append a CATEGORY_TEMPLATES[…] format directive
 *     to the final-report prompt.
 *
 * Wave 2 will compose these in the research runner (D.2.1). Wave 1 (this
 * package) ships only the leaf helpers — no orchestration.
 */

export type ResearchCategory =
  | 'product'
  | 'comparison'
  | 'howto'
  | 'factcheck'
  | 'general';

/** Constant — the full set of recognised categories, source-of-truth for membership checks. */
export const RESEARCH_CATEGORIES: readonly ResearchCategory[] = [
  'product',
  'comparison',
  'howto',
  'factcheck',
  'general',
] as const;

export interface ExtractedFinding {
  /** Why this source is relevant to the goal. */
  rational: string;
  /** Bullet-list of concrete facts/quotes/numbers extracted, with light citation markers. */
  evidence: string[];
  /** ≤3-sentence digest. */
  summary: string;
  /** Provider-side relevance score 0–1, surfaced for downstream ranking. */
  confidence: number;
}

export interface StopVerdict {
  stop: boolean;
  /** Short justification — surfaced to the UI so the user can see why we stopped. */
  reason: string;
}
