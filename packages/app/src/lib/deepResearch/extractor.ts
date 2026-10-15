/**
 * extractFromSource — goal-based extraction micro-call (Phase D item 2.5).
 *
 * Reads one source through the lens of the user's research goal and emits a
 * structured {rational, evidence, summary, confidence} tuple. This is the
 * Wave 1 leaf helper; the Wave 2 research runner will call it once per
 * fetched URL/document and pass the findings into the synthesizer.
 *
 * Key design choices:
 *   - Source content is wrapped in an UNTRUSTED_SOURCE_DATA delimiter block
 *     and lives in its own user-role message. The classifier and stop
 *     criterion get the same treatment for free wherever a report happens
 *     to come from a tool result.
 *   - Temperature 0.2 — low enough for stable structure, not 0.0 so the
 *     model can still phrase evidence bullets naturally.
 *   - Output token budget is bounded (default 500) so a misbehaving model
 *     can't spend an unbounded amount on a single source.
 *   - On parse failure we DEGRADE gracefully: return confidence 0 with the
 *     raw text shoved into evidence[0], so the runner can still rank/skip.
 *     We do not throw — a bad page should not kill the whole research run.
 */

import { streamText } from 'ai';
import type { LanguageModel, CoreMessage } from 'ai';
import { wrapUntrusted } from '../promptSecurity.js';
import {
  EXTRACTOR_SYSTEM,
  EXTRACTOR_USER_TEMPLATE,
} from './prompts.js';
import { parseLlmJson, LlmJsonParseError } from './jsonParse.js';
import type { ExtractedFinding } from './types.js';

export interface ExtractInput {
  /** The user's original research goal. */
  goal: string;
  /** Source identifier (URL or title) for citation context. */
  sourceLabel: string;
  /** Raw text content of the source, truncated upstream to max_content_chars. */
  sourceContent: string;
  /** Max tokens for the extractor output. Default 500. */
  maxOutputTokens?: number;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 500;

interface RawFinding {
  rational?: unknown;
  evidence?: unknown;
  summary?: unknown;
  confidence?: unknown;
}

function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function coerceEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === 'string' && v.trim().length > 0) {
      out.push(v);
    } else if (v !== null && v !== undefined) {
      // Stringify non-string entries defensively rather than dropping them.
      out.push(String(v));
    }
  }
  return out;
}

function coerceString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

function normaliseFinding(parsed: RawFinding): ExtractedFinding {
  return {
    rational: coerceString(parsed.rational),
    evidence: coerceEvidence(parsed.evidence),
    summary: coerceString(parsed.summary),
    confidence: clampConfidence(parsed.confidence),
  };
}

function buildFallback(raw: string, reason: string): ExtractedFinding {
  return {
    rational: `extraction failed: ${reason}`,
    evidence: raw.length > 0 ? [raw.slice(0, 2000)] : [],
    summary: 'extraction failed',
    confidence: 0,
  };
}

export async function extractFromSource(
  model: LanguageModel,
  input: ExtractInput,
  signal?: AbortSignal,
): Promise<ExtractedFinding> {
  const { goal, sourceLabel, sourceContent } = input;
  const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  const userPrompt = EXTRACTOR_USER_TEMPLATE
    .replace('{{GOAL}}', goal)
    .replace('{{SOURCE_LABEL}}', sourceLabel);

  const wrappedSource = wrapUntrusted({
    label: `source:${sourceLabel}`,
    content: sourceContent,
  });

  const messages: CoreMessage[] = [
    { role: 'user', content: userPrompt },
    wrappedSource,
  ];

  const streamOptions: Parameters<typeof streamText>[0] = {
    model,
    system: EXTRACTOR_SYSTEM,
    messages,
    temperature: 0.2,
    maxTokens: maxOutputTokens,
    ...(signal !== undefined ? { abortSignal: signal } : {}),
  };

  let raw = '';
  try {
    const stream = streamText(streamOptions);
    for await (const part of stream.fullStream) {
      if (signal?.aborted) break;
      if (part.type === 'text-delta') {
        raw += part.textDelta;
      }
    }
    if (raw === '') {
      raw = await stream.text.catch(() => '');
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    return buildFallback('', err instanceof Error ? err.message : String(err));
  }

  try {
    const parsed = parseLlmJson<RawFinding>(raw);
    return normaliseFinding(parsed);
  } catch (err) {
    const reason =
      err instanceof LlmJsonParseError
        ? 'json-parse-failed'
        : err instanceof Error
          ? err.message
          : 'unknown';
    return buildFallback(raw, reason);
  }
}
