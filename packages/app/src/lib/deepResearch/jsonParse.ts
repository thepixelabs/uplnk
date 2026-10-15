/**
 * parseLlmJson — tolerant parser for JSON returned by an LLM.
 *
 * Models trained to emit JSON still tend to wrap the payload in a Markdown
 * code fence, prefix it with a chatty sentence ("Sure! Here is the JSON:"),
 * or include trailing commas because the rationale is text-shaped not
 * grammar-shaped. We strip these reliably without enabling a full JSON5
 * dependency.
 *
 * Strategy (in order, each step idempotent):
 *   1. Strip Markdown code fences (``` ```json ... ``` `` or `` ``` ... ``` ``).
 *   2. Trim prose before the first `{` / `[` and after the last `}` / `]`.
 *   3. Try JSON.parse. On failure, strip trailing commas before `}`/`]` and retry.
 *   4. On total failure, throw LlmJsonParseError carrying the cleaned text so
 *      callers can log the actual offending payload.
 *
 * This helper is shared across extractor, stopCriterion, and (defensively)
 * categories. It never throws on whitespace — only on actually-broken JSON.
 */

export class LlmJsonParseError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = 'LlmJsonParseError';
    this.raw = raw;
  }
}

const FENCE_PATTERN = /^\s*```(?:json|JSON|jsonc|JSONC)?\s*\n?([\s\S]*?)\n?```\s*$/;

function stripFences(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(FENCE_PATTERN);
  if (match && typeof match[1] === 'string') {
    return match[1];
  }
  // Fall back: strip any leading/trailing standalone fence lines.
  return trimmed
    .replace(/^\s*```(?:json|JSON|jsonc|JSONC)?\s*\n/, '')
    .replace(/\n?\s*```\s*$/, '');
}

function trimToJsonBoundaries(input: string): string {
  // Find the earliest `{` or `[` and the latest `}` or `]`. Anything outside
  // is prose. We don't try to identify the matching pair — JSON.parse will
  // tell us if we picked the wrong bracket.
  const firstObj = input.indexOf('{');
  const firstArr = input.indexOf('[');
  const first =
    firstObj === -1
      ? firstArr
      : firstArr === -1
        ? firstObj
        : Math.min(firstObj, firstArr);
  if (first === -1) return input;

  const lastObj = input.lastIndexOf('}');
  const lastArr = input.lastIndexOf(']');
  const last = Math.max(lastObj, lastArr);
  if (last === -1 || last < first) return input;

  return input.slice(first, last + 1);
}

function stripTrailingCommas(input: string): string {
  // Conservative: only strip trailing commas that immediately precede a
  // closing `}` or `]`, possibly with whitespace between. We do NOT attempt
  // to repair other common malformations (single-quoted strings, unquoted
  // keys) — those signal a wider failure where the LLM should be re-prompted.
  return input.replace(/,(\s*[}\]])/g, '$1');
}

export function parseLlmJson<T = unknown>(raw: string): T {
  if (typeof raw !== 'string') {
    throw new LlmJsonParseError('input is not a string', String(raw));
  }

  const dropFences = stripFences(raw);
  const cleaned = trimToJsonBoundaries(dropFences).trim();

  if (cleaned.length === 0) {
    throw new LlmJsonParseError('no JSON content found in LLM output', raw);
  }

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Retry once after stripping trailing commas.
    const repaired = stripTrailingCommas(cleaned);
    try {
      return JSON.parse(repaired) as T;
    } catch (err2) {
      const reason = err2 instanceof Error ? err2.message : String(err2);
      throw new LlmJsonParseError(`failed to parse LLM JSON: ${reason}`, cleaned);
    }
  }
}
