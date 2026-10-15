/**
 * runner.ts — unit tests for runResearch.
 *
 * Strategy: mock `streamText` at the module boundary; the runner makes seven
 * distinct kinds of LLM calls (classify, plan, query-gen, extract, synth,
 * stop, final-report) and we drive each by stubbing a scripted sequence of
 * responses. The search provider is a stub object with controllable
 * `search()` behaviour.
 *
 * The mock detects which call is which by inspecting the `system` prompt
 * passed to streamText — each helper uses a distinct system text we can
 * substring-match.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LanguageModel } from 'ai';
import type { SearchProvider, SearchResult, SearchOptions } from '../../search/index.js';

// ── streamText mock infrastructure ─────────────────────────────────────────

const mockStreamText = vi.fn();
// The stop micro-call now goes through generateStructured → generateObject
// (see stopCriterion.ts). Scripted the same way as streamText below.
const mockGenerateObject = vi.fn();

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: (...args: unknown[]) => mockStreamText(...args),
    generateObject: (...args: unknown[]) => mockGenerateObject(...args),
  };
});

async function* deltaStream(parts: string[]): AsyncIterable<{ type: 'text-delta'; textDelta: string }> {
  for (const text of parts) {
    yield { type: 'text-delta' as const, textDelta: text };
  }
}

function makeStreamResult(text: string): { fullStream: AsyncIterable<unknown>; text: Promise<string> } {
  return {
    fullStream: deltaStream([text]),
    text: Promise.resolve(text),
  };
}

/** Classify which LLM call this is by inspecting the system prompt. */
type CallKind =
  | 'classify'
  | 'plan'
  | 'query-gen'
  | 'extract'
  | 'synth'
  | 'stop'
  | 'final-or-expand';

function classifyCall(call: { system?: string }): CallKind {
  const sys = call.system ?? '';
  if (sys.includes('classify research queries')) return 'classify';
  if (sys.includes('research planner')) return 'plan';
  if (sys.includes('write web-search queries')) return 'query-gen';
  if (sys.includes('research extraction agent')) return 'extract';
  if (sys.includes('maintain an evolving research report')) return 'synth';
  if (sys.includes('whether a research report has enough coverage')) return 'stop';
  if (sys.includes('write the final research report')) return 'final-or-expand';
  return 'plan'; // fallback shouldn't be reached
}

/** A scripted response per call-kind: returns the text the next call of that kind should produce. */
interface Script {
  classify?: string[];
  plan?: string[];
  queryGen?: string[];
  extract?: string[];
  synth?: string[];
  stop?: string[];
  final?: string[];
  /** Optional throw-on-Nth-call-of-kind. */
  throwOn?: Partial<Record<CallKind, { nth: number; error: Error }>>;
}

function installScript(script: Script): { counts: Record<CallKind, number> } {
  const counts: Record<CallKind, number> = {
    classify: 0,
    plan: 0,
    'query-gen': 0,
    extract: 0,
    synth: 0,
    stop: 0,
    'final-or-expand': 0,
  };
  mockStreamText.mockImplementation((call: { system?: string }) => {
    const kind = classifyCall(call);
    counts[kind]++;
    const idx = counts[kind] - 1;
    const throwSpec = script.throwOn?.[kind];
    if (throwSpec && throwSpec.nth === counts[kind]) {
      throw throwSpec.error;
    }
    let text = '';
    if (kind === 'classify') text = script.classify?.[idx] ?? 'general';
    else if (kind === 'plan') text = script.plan?.[idx] ?? '{"subQuestions":["q1"],"keyTopics":["t"],"successCriterion":"done"}';
    else if (kind === 'query-gen') text = script.queryGen?.[idx] ?? '{"queries":["fallback q"]}';
    else if (kind === 'extract')
      text = script.extract?.[idx] ?? '{"rational":"r","evidence":["e1"],"summary":"s","confidence":0.8}';
    else if (kind === 'synth') text = script.synth?.[idx] ?? `## Report\nbody ${idx + 1}`;
    else if (kind === 'stop') text = script.stop?.[idx] ?? '{"stop":false,"reason":"keep going"}';
    else if (kind === 'final-or-expand') text = script.final?.[idx] ?? `Final report body. ${'x'.repeat(1000)}`;
    return makeStreamResult(text);
  });
  // The stop verdict is the only structured (generateObject) call the runner
  // makes. Same counting + throwOn semantics as the streamText script; every
  // scripted stop text in this suite is clean JSON so JSON.parse suffices.
  mockGenerateObject.mockImplementation((call: { system?: string }) => {
    const kind = classifyCall(call);
    counts[kind]++;
    const idx = counts[kind] - 1;
    const throwSpec = script.throwOn?.[kind];
    if (throwSpec && throwSpec.nth === counts[kind]) {
      throw throwSpec.error;
    }
    const text =
      kind === 'stop'
        ? (script.stop?.[idx] ?? '{"stop":false,"reason":"keep going"}')
        : '{}';
    return Promise.resolve({
      object: JSON.parse(text) as unknown,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
  });
  return { counts };
}

// ── Stub search provider ───────────────────────────────────────────────────

interface SearchStubOptions {
  /** Per-round results — index 0 used for round 1, etc. Falls back to last entry. */
  perRound?: SearchResult[][];
  /** Throw the given error on the Nth search call. */
  throwOnCall?: { nth: number; error: Error };
}

function makeSearchStub(opts: SearchStubOptions): SearchProvider & { calls: { query: string; opts?: SearchOptions }[] } {
  const calls: { query: string; opts?: SearchOptions }[] = [];
  let n = 0;
  // Match queries to rounds by counting unique queries seen; simpler: increment
  // round index every 3-4 calls — but we want robust behaviour, so we expose
  // perRound as a flat list applied in call-order.
  return {
    name: 'stub',
    async health() { return true; },
    async search(query: string, searchOpts?: SearchOptions) {
      n++;
      calls.push({ query, ...(searchOpts !== undefined ? { opts: searchOpts } : {}) });
      if (opts.throwOnCall && opts.throwOnCall.nth === n) throw opts.throwOnCall.error;
      if (!opts.perRound) return [] as SearchResult[];
      // Use index = (n - 1), clamped to last
      const idx = Math.min(n - 1, opts.perRound.length - 1);
      return opts.perRound[idx] ?? [];
    },
    calls,
  };
}

function makeResult(url: string, content = 'content body for ' + url): SearchResult {
  return {
    url,
    title: 'T',
    snippet: 'S',
    content,
    source: 'tavily',
  };
}

const FAKE_MODEL = {} as LanguageModel;

async function collect<T extends { type: string }, R>(
  gen: AsyncGenerator<T, R, void>,
): Promise<{ events: T[]; result: R | null; error: Error | null }> {
  const events: T[] = [];
  try {
    let res = await gen.next();
    while (!res.done) {
      events.push(res.value);
      res = await gen.next();
    }
    return { events, result: res.value, error: null };
  } catch (err) {
    return { events, result: null, error: err as Error };
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('runResearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: 3 rounds → final report event order is correct', async () => {
    installScript({
      classify: ['general'],
      plan: ['{"subQuestions":["a","b"],"keyTopics":["t1"],"successCriterion":"covered"}'],
      queryGen: [
        '{"queries":["r1q1","r1q2","r1q3","r1q4"]}',
        '{"queries":["r2q1","r2q2","r2q3"]}',
        '{"queries":["r3q1","r3q2","r3q3"]}',
      ],
      stop: [
        '{"stop":false,"reason":"more needed"}',
        '{"stop":true,"reason":"covered enough"}',
      ],
      final: ['Final polished body. ' + 'x'.repeat(900)],
    });

    const search = makeSearchStub({
      perRound: [
        [makeResult('https://a.example/1'), makeResult('https://a.example/2')],
        [makeResult('https://a.example/3'), makeResult('https://a.example/4')],
        [makeResult('https://a.example/5'), makeResult('https://a.example/6')],
        [makeResult('https://a.example/7'), makeResult('https://a.example/8')],
        [makeResult('https://a.example/9'), makeResult('https://a.example/10')],
        [makeResult('https://a.example/11'), makeResult('https://a.example/12')],
        [makeResult('https://a.example/13'), makeResult('https://a.example/14')],
        [makeResult('https://a.example/15'), makeResult('https://a.example/16')],
        [makeResult('https://a.example/17'), makeResult('https://a.example/18')],
        [makeResult('https://a.example/19'), makeResult('https://a.example/20')],
      ],
    });

    const { runResearch } = await import('../runner.js');
    const gen = runResearch({ query: 'test', model: FAKE_MODEL, search, maxRounds: 5 });
    const { events, result, error } = await collect(gen);

    expect(error).toBeNull();
    expect(result).not.toBeNull();
    expect(result?.report).toContain('Final polished body');
    expect(result?.rounds).toBeGreaterThanOrEqual(2);

    const types = events.map((e) => e.type);
    const planStart = types.indexOf('plan:start');
    const planDone = types.indexOf('plan:done');
    const finalDone = types.indexOf('final:done');
    expect(planStart).toBeGreaterThanOrEqual(0);
    expect(planDone).toBeGreaterThan(planStart);
    expect(finalDone).toBeGreaterThan(planDone);
    // At least one round:start should appear before final:done
    const roundStartIdx = types.indexOf('round:start');
    expect(roundStartIdx).toBeGreaterThan(planDone);
    expect(roundStartIdx).toBeLessThan(finalDone);
  });

  it('emits final:delta events during final-report streaming', async () => {
    installScript({
      final: ['Final ' + 'word '.repeat(300)],
    });

    const search = makeSearchStub({
      perRound: [[makeResult('https://x.example/1')]],
    });

    const { runResearch } = await import('../runner.js');
    const gen = runResearch({ query: 'q', model: FAKE_MODEL, search, maxRounds: 1 });
    const { events, error } = await collect(gen);

    expect(error).toBeNull();
    const deltaCount = events.filter((e) => e.type === 'final:delta').length;
    expect(deltaCount).toBeGreaterThan(0);
  });

  it('stops early when the stop-criterion returns stop=true on round 2', async () => {
    installScript({
      stop: ['{"stop":true,"reason":"satisfied"}'],
      final: ['Body. ' + 'y'.repeat(900)],
    });

    const search = makeSearchStub({
      perRound: [
        [makeResult('https://b.example/a'), makeResult('https://b.example/b')],
        [makeResult('https://b.example/c'), makeResult('https://b.example/d')],
        [makeResult('https://b.example/e')],
      ],
    });

    const { runResearch } = await import('../runner.js');
    const gen = runResearch({ query: 'q', model: FAKE_MODEL, search, maxRounds: 5 });
    const { events, result, error } = await collect(gen);

    expect(error).toBeNull();
    const stopCheck = events.find((e) => e.type === 'stop:check') as
      | { type: 'stop:check'; verdict: { stop: boolean; reason: string } }
      | undefined;
    expect(stopCheck).toBeDefined();
    expect(stopCheck?.verdict.stop).toBe(true);
    expect(result?.rounds).toBe(2);
  });

  it('breaks after two consecutive empty-result rounds', async () => {
    installScript({
      stop: ['{"stop":false,"reason":"keep going"}', '{"stop":false,"reason":"keep going"}'],
      final: ['done ' + 'z'.repeat(900)],
    });

    // First round returns results; rounds 2 and 3 return empty arrays.
    const search = makeSearchStub({
      perRound: [
        [makeResult('https://c.example/1')],
        [],
        [],
        [],
      ],
    });

    const { runResearch } = await import('../runner.js');
    const gen = runResearch({ query: 'q', model: FAKE_MODEL, search, maxRounds: 5 });
    const { events, result, error } = await collect(gen);

    expect(error).toBeNull();
    const exhausted = events.find(
      (e) => e.type === 'error' && (e as { phase?: string }).phase === 'search-exhausted',
    );
    expect(exhausted).toBeDefined();
    expect(result?.rounds).toBeLessThanOrEqual(3);
  });

  it('aborts on wall-clock timeout and yields aborted event + throws', async () => {
    // Make synthesis hang until the runner's abortSignal fires; then throw
    // an AbortError so the runner's for-await loop unwinds.
    mockStreamText.mockImplementation((call: { system?: string; abortSignal?: AbortSignal }) => {
      const kind = classifyCall(call);
      if (kind === 'synth') {
        return {
          fullStream: (async function* () {
            // Wait until the abortSignal fires, then throw.
            await new Promise<void>((resolve) => {
              if (call.abortSignal?.aborted) { resolve(); return; }
              call.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
            });
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
          })(),
          // Use a no-op resolved promise to avoid an "unhandled rejection" warning;
          // the runner only awaits `text` if the stream produced no parts.
          text: Promise.resolve(''),
        };
      }
      const text =
        kind === 'classify'
          ? 'general'
          : kind === 'plan'
            ? '{"subQuestions":[],"keyTopics":[],"successCriterion":"x"}'
            : kind === 'query-gen'
              ? '{"queries":["q"]}'
              : kind === 'extract'
                ? '{"rational":"r","evidence":["e"],"summary":"s","confidence":0.8}'
                : kind === 'stop'
                  ? '{"stop":false,"reason":"r"}'
                  : 'final body ' + 'q'.repeat(900);
      return makeStreamResult(text);
    });

    const search = makeSearchStub({ perRound: [[makeResult('https://d.example/1')]] });
    const { runResearch } = await import('../runner.js');
    const gen = runResearch({
      query: 'q',
      model: FAKE_MODEL,
      search,
      maxRounds: 5,
      maxWallMs: 30,
    });
    const { events, error } = await collect(gen);

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/aborted/);
    const aborted = events.find((e) => e.type === 'aborted') as
      | { type: 'aborted'; reason: string }
      | undefined;
    expect(aborted).toBeDefined();
    expect(aborted?.reason).toBe('wall-clock-timeout');
  });

  it('aborts on external AbortSignal with reason "external"', async () => {
    const ac = new AbortController();

    mockStreamText.mockImplementation((call: { system?: string; abortSignal?: AbortSignal }) => {
      const kind = classifyCall(call);
      if (kind === 'classify' || kind === 'plan') {
        // Trigger external abort soon after the first hang begins.
        setTimeout(() => ac.abort(), 5);
        return {
          fullStream: (async function* () {
            await new Promise<void>((resolve) => {
              if (call.abortSignal?.aborted) { resolve(); return; }
              call.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
            });
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
          })(),
          // Use a no-op resolved promise to avoid an "unhandled rejection" warning;
          // the runner only awaits `text` if the stream produced no parts.
          text: Promise.resolve(''),
        };
      }
      return makeStreamResult('final body ' + 'a'.repeat(900));
    });

    const search = makeSearchStub({ perRound: [[]] });
    const { runResearch } = await import('../runner.js');
    const gen = runResearch({
      query: 'q',
      model: FAKE_MODEL,
      search,
      signal: ac.signal,
      maxWallMs: 10_000,
    });
    const { events, error } = await collect(gen);

    expect(error).not.toBeNull();
    const aborted = events.find((e) => e.type === 'aborted') as
      | { type: 'aborted'; reason: string }
      | undefined;
    expect(aborted?.reason).toBe('external');
  });

  it('defaults non-canonical classify response to "general"', async () => {
    installScript({
      classify: ['xyz-not-a-category'],
      final: ['Body ' + 'q'.repeat(900)],
    });
    const search = makeSearchStub({ perRound: [[makeResult('https://e.example/1')]] });
    const { runResearch } = await import('../runner.js');
    const gen = runResearch({ query: 'q', model: FAKE_MODEL, search, maxRounds: 1 });
    const { events, result, error } = await collect(gen);

    expect(error).toBeNull();
    expect(result?.category).toBe('general');
    const planDone = events.find((e) => e.type === 'plan:done') as
      | { type: 'plan:done'; category: string }
      | undefined;
    expect(planDone?.category).toBe('general');
  });

  it('expansion pass fires exactly once when initial final report is too short', async () => {
    let finalCount = 0;
    mockStreamText.mockImplementation((call: { system?: string }) => {
      const kind = classifyCall(call);
      if (kind === 'final-or-expand') {
        finalCount++;
        if (finalCount === 1) return makeStreamResult('short'); // < 800 chars
        return makeStreamResult('Expanded long body. ' + 'x'.repeat(2000));
      }
      const text =
        kind === 'classify'
          ? 'general'
          : kind === 'plan'
            ? '{"subQuestions":["q"],"keyTopics":[],"successCriterion":"x"}'
            : kind === 'query-gen'
              ? '{"queries":["one"]}'
              : kind === 'extract'
                ? '{"rational":"r","evidence":["e"],"summary":"s","confidence":0.9}'
                : kind === 'synth'
                  ? 'Draft body.'
                  : '{"stop":false,"reason":"r"}';
      return makeStreamResult(text);
    });

    const search = makeSearchStub({ perRound: [[makeResult('https://f.example/1')]] });
    const { runResearch } = await import('../runner.js');
    const gen = runResearch({ query: 'q', model: FAKE_MODEL, search, maxRounds: 1 });
    const { result, error } = await collect(gen);

    expect(error).toBeNull();
    expect(finalCount).toBe(2);
    expect(result?.report.length).toBeGreaterThan(800);
  });

  it('does NOT run a second expansion pass if the first expansion is still short', async () => {
    let finalCount = 0;
    mockStreamText.mockImplementation((call: { system?: string }) => {
      const kind = classifyCall(call);
      if (kind === 'final-or-expand') {
        finalCount++;
        return makeStreamResult(finalCount === 1 ? 'short' : 'still short');
      }
      const text =
        kind === 'classify'
          ? 'general'
          : kind === 'plan'
            ? '{"subQuestions":["q"],"keyTopics":[],"successCriterion":"x"}'
            : kind === 'query-gen'
              ? '{"queries":["one"]}'
              : kind === 'extract'
                ? '{"rational":"r","evidence":["e"],"summary":"s","confidence":0.9}'
                : kind === 'synth'
                  ? 'Draft body.'
                  : '{"stop":false,"reason":"r"}';
      return makeStreamResult(text);
    });

    const search = makeSearchStub({ perRound: [[makeResult('https://g.example/1')]] });
    const { runResearch } = await import('../runner.js');
    const gen = runResearch({ query: 'q', model: FAKE_MODEL, search, maxRounds: 1 });
    const { error } = await collect(gen);

    expect(error).toBeNull();
    expect(finalCount).toBe(2); // exactly one expansion attempt
  });

  it('continues after per-source extraction failure (error event emitted)', async () => {
    let extractCount = 0;
    mockStreamText.mockImplementation((call: { system?: string }) => {
      const kind = classifyCall(call);
      if (kind === 'extract') {
        extractCount++;
        if (extractCount === 1) {
          // Throw during stream construction → extractor's catch builds fallback finding (confidence 0).
          throw new Error('boom');
        }
        return makeStreamResult('{"rational":"r","evidence":["e"],"summary":"s","confidence":0.9}');
      }
      const text =
        kind === 'classify'
          ? 'general'
          : kind === 'plan'
            ? '{"subQuestions":["q"],"keyTopics":[],"successCriterion":"x"}'
            : kind === 'query-gen'
              ? '{"queries":["one"]}'
              : kind === 'synth'
                ? 'Draft.'
                : kind === 'stop'
                  ? '{"stop":false,"reason":"r"}'
                  : 'final body ' + 'q'.repeat(900);
      return makeStreamResult(text);
    });

    const search = makeSearchStub({
      perRound: [[makeResult('https://h.example/1'), makeResult('https://h.example/2')]],
    });
    const { runResearch } = await import('../runner.js');
    const gen = runResearch({ query: 'q', model: FAKE_MODEL, search, maxRounds: 1 });
    const { result, error } = await collect(gen);

    expect(error).toBeNull();
    // At least one source URL should have been used (the second one, confidence 0.9).
    expect(result?.sources.length).toBeGreaterThanOrEqual(1);
  });

  it('continues after per-query search failure (error event emitted)', async () => {
    installScript({
      queryGen: ['{"queries":["q-fail","q-ok"]}'],
      final: ['body ' + 'q'.repeat(900)],
    });

    const search = makeSearchStub({
      throwOnCall: { nth: 1, error: new Error('search broke') },
      perRound: [[makeResult('https://i.example/1')]],
    });
    const { runResearch } = await import('../runner.js');
    const gen = runResearch({ query: 'q', model: FAKE_MODEL, search, maxRounds: 1 });
    const { events, error } = await collect(gen);

    expect(error).toBeNull();
    const searchErr = events.find(
      (e) => e.type === 'error' && (e as { phase?: string }).phase === 'search',
    );
    expect(searchErr).toBeDefined();
  });

  it('skips classify when a category is forced and uses the forced category', async () => {
    installScript({
      final: ['body ' + 'p'.repeat(900)],
    });
    const search = makeSearchStub({ perRound: [[makeResult('https://j.example/1')]] });
    const { runResearch } = await import('../runner.js');
    const gen = runResearch({
      query: 'q',
      model: FAKE_MODEL,
      search,
      maxRounds: 1,
      category: 'product',
    });
    const { result, error } = await collect(gen);

    expect(error).toBeNull();
    expect(result?.category).toBe('product');

    // Verify the classify system prompt was NOT used in any streamText call.
    const calls = mockStreamText.mock.calls;
    const sawClassify = calls.some((c) => {
      const arg = c[0] as { system?: string };
      return (arg.system ?? '').includes('classify research queries');
    });
    expect(sawClassify).toBe(false);

    // Verify the product-category directive appears in the final-report system prompt.
    const finalCall = calls.find((c) => {
      const arg = c[0] as { system?: string };
      return (arg.system ?? '').includes('write the final research report');
    });
    expect(finalCall).toBeDefined();
    const finalSys = (finalCall![0] as { system: string }).system;
    expect(finalSys).toMatch(/ranked list of options/);
  });

  it('dedups repeated queries across rounds (search not called twice for same string)', async () => {
    installScript({
      queryGen: [
        '{"queries":["shared-q","r1-only"]}',
        '{"queries":["shared-q","r2-only"]}',
      ],
      stop: ['{"stop":true,"reason":"done"}'],
      final: ['body ' + 'p'.repeat(900)],
    });

    const search = makeSearchStub({
      perRound: [
        [makeResult('https://k.example/1')],
        [makeResult('https://k.example/2')],
        [makeResult('https://k.example/3')],
      ],
    });
    const { runResearch } = await import('../runner.js');
    const gen = runResearch({ query: 'q', model: FAKE_MODEL, search, maxRounds: 3 });
    await collect(gen);

    const queriesFired = search.calls.map((c) => c.query);
    const sharedCount = queriesFired.filter((q) => q === 'shared-q').length;
    expect(sharedCount).toBe(1);
  });

  it('dedups URLs across rounds — extracts the same URL only once', async () => {
    installScript({
      queryGen: [
        '{"queries":["r1q1","r1q2"]}',
        '{"queries":["r2q1","r2q2"]}',
      ],
      stop: ['{"stop":true,"reason":"done"}'],
      final: ['body ' + 'p'.repeat(900)],
    });

    // Both rounds return the same URL.
    const dupUrl = 'https://dup.example/page';
    const search = makeSearchStub({
      perRound: [
        [makeResult(dupUrl)],
        [makeResult(dupUrl)],
        [makeResult(dupUrl)],
        [makeResult(dupUrl)],
      ],
    });
    const { runResearch } = await import('../runner.js');
    const gen = runResearch({ query: 'q', model: FAKE_MODEL, search, maxRounds: 2 });
    await collect(gen);

    // Count extract:start events that mention the dup URL — should be 1.
    // We can verify by counting calls to streamText with extractor system prompt.
    const extractCalls = mockStreamText.mock.calls.filter((c) => {
      const arg = c[0] as { system?: string };
      return (arg.system ?? '').includes('research extraction agent');
    });
    expect(extractCalls.length).toBe(1);
  });

  it('drops findings below the confidence floor before synthesis', async () => {
    let extractIdx = 0;
    mockStreamText.mockImplementation((call: { system?: string }) => {
      const kind = classifyCall(call);
      if (kind === 'extract') {
        extractIdx++;
        // First source: high confidence. Second: very low → should be dropped.
        const conf = extractIdx === 1 ? 0.9 : 0.1;
        return makeStreamResult(
          `{"rational":"r","evidence":["e${extractIdx}"],"summary":"s","confidence":${conf}}`,
        );
      }
      const text =
        kind === 'classify'
          ? 'general'
          : kind === 'plan'
            ? '{"subQuestions":["q"],"keyTopics":[],"successCriterion":"x"}'
            : kind === 'query-gen'
              ? '{"queries":["one"]}'
              : kind === 'synth'
                ? 'Draft.'
                : kind === 'stop'
                  ? '{"stop":false,"reason":"r"}'
                  : 'body ' + 'p'.repeat(900);
      return makeStreamResult(text);
    });

    const search = makeSearchStub({
      perRound: [[makeResult('https://m.example/hi'), makeResult('https://m.example/lo')]],
    });
    const { runResearch } = await import('../runner.js');
    const gen = runResearch({ query: 'q', model: FAKE_MODEL, search, maxRounds: 1 });
    const { result, error } = await collect(gen);

    expect(error).toBeNull();
    // Only the high-confidence URL should appear in sources.
    expect(result?.sources).toEqual(['https://m.example/hi']);
  });

  it('skips stop:check on round 1 but performs it on round 2+', async () => {
    installScript({
      stop: ['{"stop":true,"reason":"done"}'],
      final: ['body ' + 'p'.repeat(900)],
    });

    const search = makeSearchStub({
      perRound: [
        [makeResult('https://n.example/1')],
        [makeResult('https://n.example/2')],
      ],
    });
    const { runResearch } = await import('../runner.js');
    const gen = runResearch({ query: 'q', model: FAKE_MODEL, search, maxRounds: 5 });
    const { events, error } = await collect(gen);

    expect(error).toBeNull();
    const stopChecks = events.filter((e) => e.type === 'stop:check') as Array<{
      type: 'stop:check';
      round: number;
    }>;
    // Should be exactly one stop:check, at round 2 (round 1 is skipped).
    expect(stopChecks.length).toBe(1);
    expect(stopChecks[0]?.round).toBe(2);
  });

  it('uses microCallModel for classify + stop when provided', async () => {
    const microModel = { tag: 'micro' } as unknown as LanguageModel;
    const mainModel = { tag: 'main' } as unknown as LanguageModel;

    installScript({
      stop: ['{"stop":true,"reason":"done"}'],
      final: ['body ' + 'q'.repeat(900)],
    });

    const search = makeSearchStub({
      perRound: [
        [makeResult('https://o.example/1')],
        [makeResult('https://o.example/2')],
      ],
    });
    const { runResearch } = await import('../runner.js');
    const gen = runResearch({
      query: 'q',
      model: mainModel,
      microCallModel: microModel,
      search,
      maxRounds: 5,
    });
    await collect(gen);

    const classifyCall = mockStreamText.mock.calls.find((c) => {
      const arg = c[0] as { system?: string };
      return (arg.system ?? '').includes('classify research queries');
    });
    expect(classifyCall).toBeDefined();
    expect((classifyCall![0] as { model: unknown }).model).toBe(microModel);

    // The stop verdict is a structured call — inspect generateObject, not streamText.
    const stopCall = mockGenerateObject.mock.calls.find((c) => {
      const arg = c[0] as { system?: string };
      return (arg.system ?? '').includes('whether a research report has enough coverage');
    });
    expect(stopCall).toBeDefined();
    expect((stopCall![0] as { model: unknown }).model).toBe(microModel);
  });
});
