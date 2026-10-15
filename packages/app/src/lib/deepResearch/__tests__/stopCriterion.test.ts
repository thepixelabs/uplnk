/**
 * stopCriterion.ts — unit tests for shouldStopResearch.
 *
 * The LLM boundary is now generateStructured (lib/structured.ts) — mocked at
 * the module boundary here. generateStructured's own retry/fallback machinery
 * is covered by lib/__tests__/structured.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGenerateStructured = vi.fn();

vi.mock('../../structured.js', () => ({
  generateStructured: (...args: unknown[]) => mockGenerateStructured(...args),
}));

const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function stubVerdict(object: unknown): void {
  mockGenerateStructured.mockResolvedValue({ object, usage: USAGE });
}

describe('shouldStopResearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns stop=false WITHOUT calling the LLM when round < 2 (round 1 quick-path)', async () => {
    const { shouldStopResearch } = await import('../stopCriterion.js');
    const verdict = await shouldStopResearch(
      {} as import('ai').LanguageModel,
      { goal: 'g', evolvingReport: 'partial', round: 1 },
    );
    expect(verdict.stop).toBe(false);
    expect(mockGenerateStructured).not.toHaveBeenCalled();
    expect(verdict.reason).toMatch(/min-rounds/);
  });

  it('returns stop=false without LLM call on round 0 too', async () => {
    const { shouldStopResearch } = await import('../stopCriterion.js');
    const verdict = await shouldStopResearch(
      {} as import('ai').LanguageModel,
      { goal: 'g', evolvingReport: '', round: 0 },
    );
    expect(verdict.stop).toBe(false);
    expect(mockGenerateStructured).not.toHaveBeenCalled();
  });

  it('returns stop=true with reason when the LLM says so', async () => {
    stubVerdict({ stop: true, reason: 'all sub-questions answered' });

    const { shouldStopResearch } = await import('../stopCriterion.js');
    const verdict = await shouldStopResearch(
      {} as import('ai').LanguageModel,
      { goal: 'g', evolvingReport: 'full', round: 3 },
    );
    expect(verdict.stop).toBe(true);
    expect(verdict.reason).toBe('all sub-questions answered');
  });

  it('returns stop=false with reason when the LLM says so', async () => {
    stubVerdict({ stop: false, reason: 'no pricing data yet' });

    const { shouldStopResearch } = await import('../stopCriterion.js');
    const verdict = await shouldStopResearch(
      {} as import('ai').LanguageModel,
      { goal: 'g', evolvingReport: 'partial', round: 2 },
    );
    expect(verdict.stop).toBe(false);
    expect(verdict.reason).toBe('no pricing data yet');
  });

  it('coerces a "true" string stop field like the pre-structured parser did', async () => {
    stubVerdict({ stop: 'true' });

    const { shouldStopResearch } = await import('../stopCriterion.js');
    const verdict = await shouldStopResearch(
      {} as import('ai').LanguageModel,
      { goal: 'g', evolvingReport: 'r', round: 2 },
    );
    expect(verdict.stop).toBe(true);
    expect(verdict.reason).toBe('model returned stop=true');
  });

  it('defaults conservatively to stop=false when generateStructured exhausts all paths', async () => {
    mockGenerateStructured.mockRejectedValue(
      new Error('LLM output is not parseable JSON after 3 structured attempt(s) and a text fallback'),
    );

    const { shouldStopResearch } = await import('../stopCriterion.js');
    const verdict = await shouldStopResearch(
      {} as import('ai').LanguageModel,
      { goal: 'g', evolvingReport: 'r', round: 4 },
    );
    expect(verdict.stop).toBe(false);
    expect(verdict.reason).toBe('parse-failed');
  });

  it('rethrows when the failure is an abort', async () => {
    const controller = new AbortController();
    const abortError = new Error('aborted');
    mockGenerateStructured.mockImplementation(() => {
      controller.abort();
      return Promise.reject(abortError);
    });

    const { shouldStopResearch } = await import('../stopCriterion.js');
    await expect(
      shouldStopResearch(
        {} as import('ai').LanguageModel,
        { goal: 'g', evolvingReport: 'r', round: 2 },
        controller.signal,
      ),
    ).rejects.toBe(abortError);
  });

  it('wraps the evolving report in UNTRUSTED_SOURCE_DATA delimiters', async () => {
    stubVerdict({ stop: false, reason: 'x' });

    const { shouldStopResearch } = await import('../stopCriterion.js');
    await shouldStopResearch(
      {} as import('ai').LanguageModel,
      { goal: 'g', evolvingReport: 'REPORT_BODY', round: 2 },
    );

    const call = mockGenerateStructured.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
      system?: string;
    };
    const wrapped = call.messages.find(
      (m) => typeof m.content === 'string' && m.content.includes('UNTRUSTED_SOURCE_DATA'),
    );
    expect(wrapped).toBeDefined();
    expect(wrapped!.content).toContain('REPORT_BODY');
    expect(wrapped!.content).toContain('label="evolving-report"');
    expect(call.system).toMatch(/STOP/i);
  });

  it('uses temperature 0.1 and a small token budget', async () => {
    stubVerdict({ stop: true, reason: 'done' });

    const { shouldStopResearch } = await import('../stopCriterion.js');
    await shouldStopResearch(
      {} as import('ai').LanguageModel,
      { goal: 'g', evolvingReport: 'r', round: 3 },
    );

    const call = mockGenerateStructured.mock.calls[0]![0] as {
      temperature?: number;
      maxTokens?: number;
    };
    expect(call.temperature).toBe(0.1);
    expect(call.maxTokens).toBe(128);
  });
});
