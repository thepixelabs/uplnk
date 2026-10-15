/**
 * runResearch — Deep Research runner (Phase D item D.2.1).
 *
 * Orchestrates the Plan → Search → Extract → Synthesize → Stop loop. Exposed
 * as an async generator so the UI can stream events (queries fired, sources
 * fetched, deltas of the final report) in real time without round-tripping
 * through a callback API.
 *
 * Invariants:
 *   - Classify + plan run ONCE up front in parallel.
 *   - Each round dedupes (a) the queries it has already issued and (b) the
 *     URLs it has already extracted. Two parallel sources serving the same
 *     URL across rounds extract only once.
 *   - Per-source extraction failures degrade — emit `error`, keep going.
 *   - Per-query search failures degrade — emit `error`, keep going.
 *   - Synthesis failure on a round is fatal to the loop (the evolving report
 *     is the single source of truth for the next round).
 *   - Stop-criterion only fires from round 2 onward, matching the helper's
 *     own quick-path. We also break on two consecutive empty-result rounds
 *     ("search exhausted").
 *   - Wall-clock + external signal compose via AbortSignal.any. On abort we
 *     emit `aborted` and re-throw so consumers' try/catch can react.
 *   - The final report has a hard minimum length (default 800 chars). If the
 *     model produces less, we run ONE expansion pass and accept that output
 *     regardless — no second retry.
 *
 * Mirrors lib/agents/orchestrator.ts in streaming style and AbortSignal use.
 */

import { streamText } from 'ai';
import type { LanguageModel, CoreMessage } from 'ai';
import {
  wrapUntrusted,
  wrapUntrustedBatch,
  UNTRUSTED_CONTEXT_POLICY,
} from '../promptSecurity.js';
import { extractFromSource } from './extractor.js';
import { shouldStopResearch } from './stopCriterion.js';
import { classifyQuery, CATEGORY_TEMPLATES } from './categories.js';
import { parseLlmJson } from './jsonParse.js';
import { RESEARCH_CATEGORIES } from './types.js';
import type { ResearchCategory } from './types.js';
import type { SearchResult } from '../search/index.js';
import type {
  CitedFinding,
  QueryPlan,
  ResearchEvent,
  ResearchPlan,
  ResearchResult,
  ResearchRunOptions,
} from './runnerTypes.js';

export type {
  ResearchEvent,
  ResearchResult,
  ResearchRunOptions,
} from './runnerTypes.js';

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_ROUNDS = 5;
const DEFAULT_MAX_WALL_MS = 300_000;
const DEFAULT_MAX_CONTENT_CHARS = 15_000;
const DEFAULT_EXTRACTION_CONCURRENCY = 3;
const DEFAULT_SYNTHESIS_WINDOW = 10;
const DEFAULT_SEARCH_RESULTS_PER_QUERY = 6;
const MIN_REPORT_CHARS = 800;
const MIN_EXTRACTION_CONFIDENCE = 0.3;
const PLAN_MAX_OUTPUT_TOKENS = 600;
const QUERY_GEN_MAX_OUTPUT_TOKENS = 400;
const SYNTHESIS_MAX_OUTPUT_TOKENS = 1500;
const FINAL_REPORT_MAX_OUTPUT_TOKENS = 4096;
const EXPANSION_MAX_OUTPUT_TOKENS = 4096;

// ── Prompts (kept here, runner-local — Wave 1 prompts.ts is for leaves) ──────

const PLAN_SYSTEM = `
You are a research planner. Given a user's research goal, you decompose it
into a concrete plan the downstream researcher will execute.

Posture:
- Be specific. Vague sub-questions produce vague queries produce vague reports.
- 3 to 6 sub-questions is the right size. Fewer if the goal is narrow.
- "successCriterion" is a single sentence the synthesizer will use to know
  when the report is done.

Output ONLY a single JSON object with this exact shape — no prose, no fences:

  {
    "subQuestions":     ["<sub-question 1>", "<sub-question 2>", "..."],
    "keyTopics":        ["<topic 1>", "<topic 2>", "..."],
    "successCriterion": "<one sentence>"
  }
`.trim();

const PLAN_USER_TEMPLATE = `
Research goal:
{{QUERY}}

Detected category: {{CATEGORY}}

Produce the plan JSON described in the system prompt.
`.trim();

const QUERY_GEN_SYSTEM = `
You write web-search queries that fill specific gaps in an evolving research
report.

Posture:
- On round 1 the report is empty: emit 4 BROAD queries that cover the goal's
  main facets (terms, entities, sub-questions). Variety beats precision here.
- On rounds 2+ the report exists: emit 3 TARGETED queries that fill identified
  gaps (unanswered sub-questions, missing citations, contradicted claims).
  Reuse named entities from the evolving report.
- Each query is a single search string (no quotes around the whole thing
  unless intentional). Aim for terms a human would type into Google.

Output ONLY a single JSON object with this exact shape — no prose, no fences:

  {
    "queries": ["<query 1>", "<query 2>", "..."]
  }
`.trim();

const QUERY_GEN_USER_TEMPLATE = `
Research goal:
{{QUERY}}

Round: {{ROUND}}

Plan:
{{PLAN_DIGEST}}

The next message contains the evolving report so far (may be empty on round 1),
wrapped as untrusted data. Emit the JSON object described above.
`.trim();

const SYNTHESIS_SYSTEM = `
You maintain an evolving research report. Each round you receive new findings
from freshly fetched sources and merge them into the current report.

Posture:
- Keep what's already there if it's still accurate. Add what's new. Remove
  what's been contradicted by a higher-confidence source.
- Inline-cite sources by URL in square brackets, e.g. [https://example.com].
- Markdown headings welcome. Bullet lists welcome. No emojis.
- Do not exceed roughly 1500 words at this stage — the FINAL synthesizer
  expands later. Brevity now keeps the next round's context manageable.

Output the FULL updated report as Markdown. No JSON, no prose preface.
`.trim();

const SYNTHESIS_USER_TEMPLATE = `
Research goal:
{{QUERY}}

Round: {{ROUND}}

The next message contains the current report and the new findings to merge,
all wrapped as untrusted data. Produce the FULL updated report.
`.trim();

const FINAL_REPORT_SYSTEM = `
You write the final research report from an evolving draft. The draft has
already aggregated findings round-by-round; your job is to polish, structure,
and ensure every nontrivial claim carries an inline citation in square brackets.

Style:
- Markdown headings, clear section structure, no emojis.
- Inline citations using the URL: [https://example.com].
- Close with a "Sources" section listing every cited URL once.
- Prefer concrete numbers, dates, and direct quotes over generic prose.

The category-specific directive will follow in the system prompt below.
`.trim();

const EXPANSION_USER_TEMPLATE = `
The previous report draft is too short to be useful. Expand it with greater
depth, more concrete detail, more inline citations, and more structure.
Preserve the existing citations. Do not invent sources that were not already
cited. Aim for at least {{MIN_CHARS}} characters of Markdown.
`.trim();

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Stream text from the model into a single string. Mirrors the leaf-helper pattern. */
async function streamToString(
  model: LanguageModel,
  system: string,
  messages: CoreMessage[],
  opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal },
): Promise<string> {
  const streamOptions: Parameters<typeof streamText>[0] = {
    model,
    system,
    messages,
    temperature: opts.temperature ?? 0.4,
    maxTokens: opts.maxTokens ?? 1024,
    ...(opts.signal !== undefined ? { abortSignal: opts.signal } : {}),
  };
  const stream = streamText(streamOptions);
  let out = '';
  for await (const part of stream.fullStream) {
    if (opts.signal?.aborted) break;
    if (part.type === 'text-delta') out += part.textDelta;
  }
  if (out === '') out = await stream.text.catch(() => '');
  return out;
}

/** Minimal semaphore — one line: a Promise-chain queue gated to N slots. */
function makeSemaphore(maxConcurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (active < maxConcurrency) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiters.push(() => { active++; resolve(); }));
  };
  const release = (): void => {
    active--;
    const next = waiters.shift();
    if (next) next();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    await acquire();
    try { return await fn(); } finally { release(); }
  };
}

/** Pick the searchable content for a result — Tavily gives full content, others give snippet. */
function pickContent(result: SearchResult, maxChars: number): string {
  const body = result.content && result.content.length > 0 ? result.content : result.snippet;
  if (body.length <= maxChars) return body;
  return body.slice(0, maxChars);
}

/** Tolerant parse of a plan response into a fully-shaped ResearchPlan. */
function parsePlan(raw: string): ResearchPlan {
  let parsed: { subQuestions?: unknown; keyTopics?: unknown; successCriterion?: unknown } = {};
  try {
    parsed = parseLlmJson(raw);
  } catch {
    // fall through with empty parsed
  }
  const subQuestions = Array.isArray(parsed.subQuestions)
    ? parsed.subQuestions.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    : [];
  const keyTopics = Array.isArray(parsed.keyTopics)
    ? parsed.keyTopics.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    : [];
  const successCriterion =
    typeof parsed.successCriterion === 'string' && parsed.successCriterion.trim() !== ''
      ? parsed.successCriterion
      : 'The report substantively answers the user goal with cited evidence.';
  return { subQuestions, keyTopics, successCriterion };
}

/** Tolerant parse of a query-generation response. */
function parseQueryPlan(raw: string, fallback: string): QueryPlan {
  let parsed: { queries?: unknown } = {};
  try {
    parsed = parseLlmJson(raw);
  } catch {
    return { queries: [fallback] };
  }
  const queries = Array.isArray(parsed.queries)
    ? parsed.queries.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    : [];
  return { queries: queries.length > 0 ? queries : [fallback] };
}

/** Render a plan into the short string we inline into query-gen + final prompts. */
function digestPlan(plan: ResearchPlan): string {
  const subs = plan.subQuestions.length > 0
    ? plan.subQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')
    : '(no explicit sub-questions)';
  const topics = plan.keyTopics.length > 0 ? plan.keyTopics.join(', ') : '(none)';
  return `Sub-questions:\n${subs}\n\nKey topics: ${topics}\n\nSuccess criterion: ${plan.successCriterion}`;
}

/** 2-line plan summary surfaced via plan:done event. */
function summarisePlan(plan: ResearchPlan): string {
  const subs = plan.subQuestions.slice(0, 3).join(' / ');
  return `${plan.subQuestions.length} sub-question(s): ${subs || '(none)'}\nSuccess: ${plan.successCriterion}`;
}

/** Normalise a URL for dedup — strip trailing slash, fragment, lowercase host. */
function normaliseUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return url.trim();
  }
}

/** Lower-cased, whitespace-collapsed query key for dedup across rounds. */
function normaliseQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Render a small batch of findings as a Markdown block the synthesizer can ingest. */
function renderFindingsBlock(findings: readonly CitedFinding[]): string {
  if (findings.length === 0) return '(no new findings this round)';
  return findings
    .map((f) => {
      const bullets = f.evidence.map((e) => `  - ${e}`).join('\n');
      return [
        `### Source: ${f.url}`,
        `Confidence: ${f.confidence.toFixed(2)}`,
        `Rational: ${f.rational}`,
        bullets || '  - (no evidence bullets)',
        `Summary: ${f.summary}`,
      ].join('\n');
    })
    .join('\n\n');
}

// ── Main generator ──────────────────────────────────────────────────────────

export async function* runResearch(
  opts: ResearchRunOptions,
): AsyncGenerator<ResearchEvent, ResearchResult, void> {
  const {
    query,
    model,
    search,
    signal: externalSignal,
    includeDomains,
    excludeDomains,
  } = opts;
  const microCallModel = opts.microCallModel ?? model;
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxWallMs = opts.maxWallMs ?? DEFAULT_MAX_WALL_MS;
  const maxContentChars = opts.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const extractionConcurrency = opts.extractionConcurrency ?? DEFAULT_EXTRACTION_CONCURRENCY;
  const synthesisWindow = opts.synthesisWindow ?? DEFAULT_SYNTHESIS_WINDOW;

  // Compose abort: wall-clock + optional external. AbortSignal.any wants at
  // least one signal; we always pass timeout, then optionally external.
  const timeoutSignal = AbortSignal.timeout(maxWallMs);
  const composedSignals: AbortSignal[] =
    externalSignal !== undefined ? [externalSignal, timeoutSignal] : [timeoutSignal];
  const abortSignal = AbortSignal.any(composedSignals);

  /** Maps an AbortError into our abort-reason string. */
  const abortReason = (): string => {
    if (externalSignal?.aborted) return 'external';
    if (timeoutSignal.aborted) return 'wall-clock-timeout';
    return 'unknown-abort';
  };

  const startMs = Date.now();
  let category: ResearchCategory = opts.category ?? 'general';
  let plan: ResearchPlan = { subQuestions: [], keyTopics: [], successCriterion: '' };
  let evolvingReport = '';
  const allFindings: CitedFinding[] = [];
  const seenQueries = new Set<string>();
  const visitedUrls = new Set<string>();
  let consecutiveEmptyRounds = 0;
  let roundsExecuted = 0;

  try {
    // ── Phase 1: Plan + classify (concurrent) ─────────────────────────────
    yield { type: 'plan:start' };

    const classifyPromise: Promise<ResearchCategory> = opts.category !== undefined
      ? Promise.resolve(opts.category)
      : classifyQuery(microCallModel, query, abortSignal).catch(() => 'general' as ResearchCategory);

    const planPromise: Promise<ResearchPlan> = (async () => {
      const userPrompt = PLAN_USER_TEMPLATE
        .replace('{{QUERY}}', query)
        .replace('{{CATEGORY}}', opts.category ?? 'auto');
      try {
        const raw = await streamToString(
          microCallModel,
          PLAN_SYSTEM,
          [{ role: 'user', content: userPrompt }],
          { temperature: 0.2, maxTokens: PLAN_MAX_OUTPUT_TOKENS, signal: abortSignal },
        );
        return parsePlan(raw);
      } catch {
        return parsePlan('');
      }
    })();

    const [rawCategory, parsedPlan] = await Promise.all([classifyPromise, planPromise]);

    // Coerce non-canonical category to 'general' (defensive — classifyQuery does this too).
    category = (RESEARCH_CATEGORIES as readonly string[]).includes(rawCategory)
      ? rawCategory
      : 'general';
    plan = parsedPlan;

    yield { type: 'plan:done', category, planSummary: summarisePlan(plan) };

    if (abortSignal.aborted) throw new Error('aborted');

    // ── Phase 2: iterative rounds ─────────────────────────────────────────
    for (let round = 1; round <= maxRounds; round++) {
      if (abortSignal.aborted) throw new Error('aborted');

      const roundStartMs = Date.now();

      // -- Query generation -----------------------------------------------
      let queries: string[];
      try {
        const queryGenUserPrompt = QUERY_GEN_USER_TEMPLATE
          .replace('{{QUERY}}', query)
          .replace('{{ROUND}}', String(round))
          .replace('{{PLAN_DIGEST}}', digestPlan(plan));
        const wrappedReport = wrapUntrusted({
          label: 'evolving-report',
          content: evolvingReport || '(empty — round 1)',
        });
        const raw = await streamToString(
          model,
          QUERY_GEN_SYSTEM,
          [{ role: 'user', content: queryGenUserPrompt }, wrappedReport],
          { temperature: 0.4, maxTokens: QUERY_GEN_MAX_OUTPUT_TOKENS, signal: abortSignal },
        );
        queries = parseQueryPlan(raw, query).queries;
      } catch (err) {
        if (abortSignal.aborted) throw err;
        yield {
          type: 'error',
          phase: 'query-gen',
          message: err instanceof Error ? err.message : String(err),
        };
        queries = [query];
      }

      // Dedup vs the cross-round set
      const dedupedQueries: string[] = [];
      for (const q of queries) {
        const key = normaliseQuery(q);
        if (key === '' || seenQueries.has(key)) continue;
        seenQueries.add(key);
        dedupedQueries.push(q);
      }

      yield { type: 'round:start', round, queries: dedupedQueries };

      // -- Parallel search -----------------------------------------------
      const searchOpts = {
        count: DEFAULT_SEARCH_RESULTS_PER_QUERY,
        signal: abortSignal,
        ...(includeDomains !== undefined ? { includeDomains } : {}),
        ...(excludeDomains !== undefined ? { excludeDomains } : {}),
      } as const;

      const searchPromises = dedupedQueries.map(async (q) => {
        try {
          const results = await search.search(q, searchOpts);
          return { q, results, error: null as string | null };
        } catch (err) {
          return {
            q,
            results: [] as SearchResult[],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      });

      const searchOutcomes = await Promise.all(searchPromises);

      // Collect every unique new URL (dedup vs visitedUrls and within this round).
      const roundSources: Array<{ url: string; content: string; query: string }> = [];
      for (const outcome of searchOutcomes) {
        if (outcome.error !== null) {
          yield { type: 'error', phase: 'search', message: outcome.error };
          continue;
        }
        yield {
          type: 'search:result',
          round,
          query: outcome.q,
          resultCount: outcome.results.length,
        };
        for (const r of outcome.results) {
          const norm = normaliseUrl(r.url);
          if (visitedUrls.has(norm)) continue;
          visitedUrls.add(norm);
          const content = pickContent(r, maxContentChars);
          if (content.trim() === '') continue;
          roundSources.push({ url: r.url, content, query: outcome.q });
        }
      }

      // -- Parallel extraction (semaphore-gated) -------------------------
      const sem = makeSemaphore(extractionConcurrency);

      // We emit events as soon as each extraction starts/finishes. Because a
      // generator can only `yield` from the top stack frame, we collect the
      // events on a queue and drain after Promise.all returns. (This is OK
      // for the round-level animation; per-source timing is recorded inside
      // the event.)
      const extractionEvents: ResearchEvent[] = [];
      const newFindingsThisRound: CitedFinding[] = [];

      const extractTasks = roundSources.map((src) => sem(async () => {
        extractionEvents.push({ type: 'extract:start', round, sourceUrl: src.url });
        try {
          const finding = await extractFromSource(
            model,
            {
              goal: query,
              sourceLabel: src.url,
              sourceContent: src.content,
            },
            abortSignal,
          );
          extractionEvents.push({
            type: 'extract:done',
            round,
            sourceUrl: src.url,
            confidence: finding.confidence,
          });
          if (finding.confidence >= MIN_EXTRACTION_CONFIDENCE) {
            newFindingsThisRound.push({ ...finding, url: src.url, round });
          }
        } catch (err) {
          if (abortSignal.aborted) throw err;
          extractionEvents.push({
            type: 'error',
            phase: 'extract',
            message: `${src.url}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }));

      try {
        await Promise.all(extractTasks);
      } catch (err) {
        if (abortSignal.aborted) throw err;
        // Individual task failures are caught inside the task; reaching here
        // means a non-abort error escaped. Emit a generic error and continue.
        yield {
          type: 'error',
          phase: 'extract',
          message: err instanceof Error ? err.message : String(err),
        };
      }

      // Drain queued per-source events to the consumer.
      for (const ev of extractionEvents) yield ev;

      allFindings.push(...newFindingsThisRound);

      // -- Synthesis -----------------------------------------------------
      yield { type: 'synthesize:start', round };

      const synthesisFindings = allFindings.slice(-synthesisWindow);

      let synthFailed = false;
      try {
        const synthUser = SYNTHESIS_USER_TEMPLATE
          .replace('{{QUERY}}', query)
          .replace('{{ROUND}}', String(round));
        const wrapped = wrapUntrustedBatch([
          { label: 'current-report', content: evolvingReport || '(empty — first round)' },
          { label: 'new-findings', content: renderFindingsBlock(synthesisFindings) },
        ]);
        const messages: CoreMessage[] = wrapped !== null
          ? [{ role: 'user', content: synthUser }, wrapped]
          : [{ role: 'user', content: synthUser }];
        const next = await streamToString(
          model,
          `${UNTRUSTED_CONTEXT_POLICY}\n\n${SYNTHESIS_SYSTEM}`,
          messages,
          {
            temperature: 0.4,
            maxTokens: SYNTHESIS_MAX_OUTPUT_TOKENS,
            signal: abortSignal,
          },
        );
        if (next.trim().length > 0) {
          evolvingReport = next;
        }
      } catch (err) {
        if (abortSignal.aborted) throw err;
        synthFailed = true;
        yield {
          type: 'error',
          phase: 'synthesize',
          message: err instanceof Error ? err.message : String(err),
        };
      }

      yield { type: 'synthesize:done', round, reportLength: evolvingReport.length };

      if (synthFailed) {
        roundsExecuted = round;
        yield {
          type: 'round:end',
          round,
          durationMs: Date.now() - roundStartMs,
          newFindingsCount: newFindingsThisRound.length,
        };
        break;
      }

      // -- Stop check (round >= 2) --------------------------------------
      let stopRequested = false;
      if (round >= 2) {
        try {
          const verdict = await shouldStopResearch(
            microCallModel,
            { goal: query, evolvingReport, round },
            abortSignal,
          );
          yield { type: 'stop:check', round, verdict };
          stopRequested = verdict.stop;
        } catch (err) {
          if (abortSignal.aborted) throw err;
          yield {
            type: 'error',
            phase: 'stop',
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }

      // -- Empty-round tracking ----------------------------------------
      if (newFindingsThisRound.length === 0) consecutiveEmptyRounds++;
      else consecutiveEmptyRounds = 0;

      const roundDur = Date.now() - roundStartMs;
      yield {
        type: 'round:end',
        round,
        durationMs: roundDur,
        newFindingsCount: newFindingsThisRound.length,
      };
      roundsExecuted = round;

      if (stopRequested) break;
      if (consecutiveEmptyRounds >= 2) {
        yield {
          type: 'error',
          phase: 'search-exhausted',
          message: 'two consecutive rounds returned zero new findings — stopping',
        };
        break;
      }
    }

    // ── Phase 3: final report ──────────────────────────────────────────
    if (abortSignal.aborted) throw new Error('aborted');

    yield { type: 'final:start' };

    const finalSystem = [
      UNTRUSTED_CONTEXT_POLICY,
      FINAL_REPORT_SYSTEM,
      CATEGORY_TEMPLATES[category],
    ].join('\n\n');

    const finalUserPrompt = `Research goal:\n${query}\n\nThe next message contains the draft report so far, wrapped as untrusted data. Polish and finalise it per the system instructions.`;
    const wrappedDraft = wrapUntrustedBatch([
      { label: 'draft-report', content: evolvingReport || '(no draft was produced)' },
    ]);
    const finalMessages: CoreMessage[] = wrappedDraft !== null
      ? [{ role: 'user', content: finalUserPrompt }, wrappedDraft]
      : [{ role: 'user', content: finalUserPrompt }];

    let finalText = '';
    {
      const stream = streamText({
        model,
        system: finalSystem,
        messages: finalMessages,
        temperature: 0.5,
        maxTokens: FINAL_REPORT_MAX_OUTPUT_TOKENS,
        abortSignal,
      });
      for await (const part of stream.fullStream) {
        if (abortSignal.aborted) break;
        if (part.type === 'text-delta') {
          finalText += part.textDelta;
          yield { type: 'final:delta', delta: part.textDelta };
        }
      }
      if (finalText === '') finalText = await stream.text.catch(() => '');
    }

    if (abortSignal.aborted) throw new Error('aborted');

    // One-shot expansion if too short. Strict "once and only once" guard.
    if (finalText.trim().length < MIN_REPORT_CHARS) {
      const expandUser = EXPANSION_USER_TEMPLATE.replace('{{MIN_CHARS}}', String(MIN_REPORT_CHARS));
      const wrappedShort = wrapUntrustedBatch([
        { label: 'short-draft', content: finalText },
        { label: 'original-draft', content: evolvingReport },
      ]);
      const expandMessages: CoreMessage[] = wrappedShort !== null
        ? [{ role: 'user', content: expandUser }, wrappedShort]
        : [{ role: 'user', content: expandUser }];
      try {
        const expanded = await streamToString(
          model,
          finalSystem,
          expandMessages,
          {
            temperature: 0.5,
            maxTokens: EXPANSION_MAX_OUTPUT_TOKENS,
            signal: abortSignal,
          },
        );
        if (expanded.trim().length > finalText.trim().length) {
          // Note: expansion output is NOT streamed via final:delta — the
          // consumer has already buffered the short version; the expansion
          // is a quiet replacement. UI can subscribe to final:done.
          finalText = expanded;
        }
      } catch (err) {
        if (abortSignal.aborted) throw err;
        yield {
          type: 'error',
          phase: 'expand',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Deduped source URLs in insertion order — preserves the citation pattern
    // the synthesizer produces (first-seen wins).
    const sourceSet = new Set<string>();
    const sources: string[] = [];
    for (const f of allFindings) {
      if (sourceSet.has(f.url)) continue;
      sourceSet.add(f.url);
      sources.push(f.url);
    }

    const durationMs = Date.now() - startMs;
    yield {
      type: 'final:done',
      report: finalText,
      sources,
      durationMs,
    };

    return {
      report: finalText,
      sources,
      category,
      rounds: roundsExecuted,
      durationMs,
    };
  } catch (err) {
    if (abortSignal.aborted) {
      const reason = abortReason();
      yield { type: 'aborted', reason };
      throw new Error(`research aborted: ${reason}`);
    }
    throw err;
  }
}
