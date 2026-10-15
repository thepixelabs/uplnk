/**
 * Prompt templates for the Deep Research package.
 *
 * Single source of truth. Each prompt is a `const` string so behavioural
 * changes have one place to land, tests can assert on substrings, and
 * evals can diff revisions.
 *
 * Conventions:
 *   - System prompts define ROLE + OUTPUT-SHAPE + the model's posture
 *     (skeptical, decisive, calibrated). They never name the LLM provider.
 *   - User prompts carry the goal, the wrapped source/report content
 *     (via promptSecurity.wrapUntrusted), and the JSON-schema instruction.
 *   - Output instructions specify the EXACT JSON keys we expect so the
 *     tolerant parser has a chance. We do not depend on JSON-mode flags
 *     because not every provider routes them — the parser handles fences.
 *   - Category templates are short directives appended to the FINAL-REPORT
 *     prompt downstream (in Wave 2). They live here because the choice of
 *     directive is part of the prompt-engineering surface.
 */

import type { ResearchCategory } from './types.js';

// ── Extractor (D.2.5) ────────────────────────────────────────────────────────

/**
 * System prompt for the goal-based extractor.
 *
 * The pivot vs generic summarisation: the model reads with a specific
 * research goal in mind and emits {rational, evidence, summary, confidence}
 * tuned to that goal. A page that's broadly about Topic X but doesn't
 * actually answer the user's goal should come back with low confidence
 * and thin evidence — not a polite, balanced summary.
 */
export const EXTRACTOR_SYSTEM = `
You are a research extraction agent. You read one source at a time through the
lens of the user's research goal and emit a STRUCTURED finding.

Posture:
- Be a skeptical analyst, not a summariser. If the source does not actually
  address the goal, say so via low confidence and minimal evidence.
- Prefer concrete facts, quotes, numbers, dates, and named entities over
  paraphrase. Direct quotes get wrapped in "…".
- Distinguish claims from opinion. Note when a claim is unsupported.
- Never invent content not present in the source. If a field has no signal,
  leave its value short or empty rather than padding.

Output:
Return ONLY a single JSON object with this exact shape — no prose before or
after, no Markdown fences:

  {
    "rational": "<one to two sentences: why this source is or is not relevant to the goal>",
    "evidence": ["<bullet 1>", "<bullet 2>", "..."],
    "summary": "<at most three sentences: the source's contribution to the goal>",
    "confidence": <number from 0.0 to 1.0; 0 = no useful signal, 1 = direct, authoritative answer>
  }

The "evidence" array MUST be a list of strings, each one a short standalone
bullet. Include light citation markers when quoting: e.g. ["\\"X reduces Y by 30%\\" — §3"].
`.trim();

/**
 * User prompt template for the extractor. Placeholders:
 *   {{GOAL}}        — the user's research goal (trusted input)
 *   {{SOURCE_LABEL}}— short identifier for the source (URL or title), trusted
 *
 * The source body is appended SEPARATELY as a wrapped-untrusted user message;
 * we do NOT inline it here so the prompt-injection delimiters land verbatim.
 */
export const EXTRACTOR_USER_TEMPLATE = `
Research goal:
{{GOAL}}

The next message contains the source content for "{{SOURCE_LABEL}}", wrapped
as untrusted data. Read it through the lens of the goal above and emit the
JSON object described in the system prompt. Output JSON only.
`.trim();

// ── Stop criterion (D.2.7) ───────────────────────────────────────────────────

/**
 * System prompt for the per-round stop decision.
 *
 * Bias toward STOPPING. The cost of one more research round is real (latency,
 * tokens, user attention); the cost of an "incomplete but reasonable" report
 * is a follow-up question. We accept the latter to avoid runaway loops.
 */
export const STOP_SYSTEM = `
You decide whether a research report has enough coverage to STOP iterating.

Posture:
- Err toward stopping. If the report substantively answers the user's goal
  with cited evidence, say stop=true. Do not demand exhaustiveness.
- Continue only when a CONCRETE gap exists: an unanswered sub-question, a
  contradicted claim that needs a tiebreaker source, or a glaring missing
  category (e.g. "no pricing data" for a product-comparison goal).
- One sentence is enough for the reason. The user will read it in the UI.

Output:
Return ONLY a single JSON object with this exact shape — no prose, no fences:

  {
    "stop":   <true | false>,
    "reason": "<one short sentence>"
  }
`.trim();

/**
 * User prompt for the stop decision. Goal is trusted; the report is wrapped
 * as untrusted data in a separate message before this prompt is sent.
 */
export const STOP_USER_TEMPLATE = `
Research goal:
{{GOAL}}

Current round: {{ROUND}}

The next message contains the evolving research report, wrapped as untrusted
data. Decide whether the report already answers the goal well enough to stop,
and emit the JSON object described in the system prompt. Output JSON only.
`.trim();

// ── Category classifier (D.2.6) ──────────────────────────────────────────────

/**
 * Classifier prompt. Designed for a single-token answer at temperature 0 —
 * no JSON, no reasoning, no preamble. We parse the response by trimming
 * and lowercasing and checking set membership.
 */
export const CATEGORY_SYSTEM = `
You classify research queries into exactly one of these categories:

  product     — the user wants to choose, buy, or evaluate a thing
                (e.g. "best mechanical keyboard under $150").
  comparison  — the user wants A vs B (or A vs B vs C) decided
                (e.g. "Postgres vs MySQL for analytics workloads").
  howto       — the user wants steps to accomplish a task
                (e.g. "how do I configure nginx as a reverse proxy").
  factcheck   — the user wants to verify a specific claim
                (e.g. "is it true that coffee causes cancer").
  general     — anything else: open-ended explanation, exploration, history.

Rules:
- Respond with exactly ONE of the five words above, lowercase, no punctuation.
- No explanation, no preamble, no Markdown. One word only.
- If uncertain, choose "general".
`.trim();

/**
 * Wraps the query in a one-line user prompt. The query itself is trusted
 * (the user typed it this turn) so no untrusted-context wrapping.
 */
export const CATEGORY_USER_TEMPLATE = `Query: {{QUERY}}\n\nCategory:`;

// ── Category templates (D.2.6 output side) ───────────────────────────────────

/**
 * Format directives appended to the FINAL-REPORT prompt in Wave 2.
 * Each one says how the synthesizer should SHAPE the output for its category.
 * Kept short — the synthesizer system prompt does the heavy lifting, this
 * is a steering nudge.
 */
export const CATEGORY_TEMPLATES: Readonly<Record<ResearchCategory, string>> = {
  product:
    'Output as a ranked list of options. For each, give 2–4 pros and 1–3 cons grounded in cited evidence. Close with a one-line recommendation that names a primary pick and one runner-up for a different use case.',
  comparison:
    'Output as a side-by-side table with these columns: feature, option A, option B (extend to C if the goal names three). Above the table, a one-sentence framing of what the user is choosing between. Below the table, a verdict paragraph naming the winner conditional on use case.',
  howto:
    'Output as numbered steps. Begin with a "Prerequisites" section listing required tools, accounts, or knowledge. End each step with the expected observable outcome. Close with a "Common pitfalls" section listing 2–4 failure modes.',
  factcheck:
    'Output in four sections: (1) The claim, restated verbatim. (2) Supporting evidence, with citations. (3) Contradicting evidence, with citations. (4) Verdict — one of: true, mostly true, mixed, mostly false, false, unverifiable — with a one-sentence justification.',
  general:
    'Output as a well-structured article with clear section headings, inline citations to sources, and a short introduction that frames the scope. Close with a "Further reading" list of the 3–5 most useful sources.',
};
