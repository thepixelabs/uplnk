/**
 * extractor.ts — unit tests for extractFromSource.
 *
 * streamText is mocked at the module boundary. Each test stubs the stream
 * to return controlled text deltas, then asserts on the parsed finding
 * and on the messages we sent to the SDK.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStreamText = vi.fn();

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: (...args: unknown[]) => mockStreamText(...args),
  };
});

async function* deltaStream(parts: string[]) {
  for (const text of parts) {
    yield { type: 'text-delta' as const, textDelta: text };
  }
}

function stubStream(text: string): void {
  mockStreamText.mockReturnValue({
    fullStream: deltaStream([text]),
    text: Promise.resolve(text),
  });
}

describe('extractFromSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses a well-formed JSON response into ExtractedFinding', async () => {
    stubStream(
      JSON.stringify({
        rational: 'directly answers the goal',
        evidence: ['"X reduces Y by 30%"', 'release dated 2026-01-04'],
        summary: 'Source claims X reduces Y; release dated Jan 2026.',
        confidence: 0.85,
      }),
    );

    const { extractFromSource } = await import('../extractor.js');
    const result = await extractFromSource(
      {} as import('ai').LanguageModel,
      {
        goal: 'Does X reduce Y?',
        sourceLabel: 'example.com/x-y',
        sourceContent: 'X reduces Y by 30% in benchmark Z.',
      },
    );

    expect(result.rational).toBe('directly answers the goal');
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence[0]).toContain('30%');
    expect(result.summary).toContain('X reduces Y');
    expect(result.confidence).toBe(0.85);
  });

  it('clamps confidence above 1 and below 0', async () => {
    stubStream(
      JSON.stringify({
        rational: 'r',
        evidence: ['e'],
        summary: 's',
        confidence: 7,
      }),
    );

    const { extractFromSource } = await import('../extractor.js');
    const result = await extractFromSource(
      {} as import('ai').LanguageModel,
      { goal: 'g', sourceLabel: 'l', sourceContent: 'c' },
    );
    expect(result.confidence).toBe(1);
  });

  it('returns a low-confidence fallback when the LLM emits prose instead of JSON', async () => {
    stubStream(
      "I'm sorry, I can't parse that page into structured form. It seems empty.",
    );

    const { extractFromSource } = await import('../extractor.js');
    const result = await extractFromSource(
      {} as import('ai').LanguageModel,
      { goal: 'g', sourceLabel: 'l', sourceContent: 'c' },
    );

    expect(result.confidence).toBe(0);
    expect(result.summary).toBe('extraction failed');
    expect(result.evidence[0]).toContain("can't parse");
  });

  it('wraps the source content in UNTRUSTED_SOURCE_DATA delimiters', async () => {
    stubStream('{"rational":"r","evidence":[],"summary":"s","confidence":0.5}');

    const { extractFromSource } = await import('../extractor.js');
    await extractFromSource(
      {} as import('ai').LanguageModel,
      {
        goal: 'goal',
        sourceLabel: 'example.com',
        sourceContent: 'page text body',
      },
    );

    const call = mockStreamText.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const wrapped = call.messages.find(
      (m) => typeof m.content === 'string' && m.content.includes('UNTRUSTED_SOURCE_DATA'),
    );
    expect(wrapped).toBeDefined();
    expect(wrapped!.role).toBe('user');
    expect(wrapped!.content).toContain('label="source:example.com"');
    expect(wrapped!.content).toContain('page text body');
    expect(wrapped!.content).toContain('END_UNTRUSTED_SOURCE_DATA');
  });

  it('uses the extractor system prompt and a low temperature', async () => {
    stubStream('{"rational":"r","evidence":[],"summary":"s","confidence":0.5}');

    const { extractFromSource } = await import('../extractor.js');
    await extractFromSource(
      {} as import('ai').LanguageModel,
      { goal: 'g', sourceLabel: 'l', sourceContent: 'c' },
    );

    const call = mockStreamText.mock.calls[0]![0] as {
      system?: string;
      temperature?: number;
      maxTokens?: number;
    };
    expect(call.system).toMatch(/research extraction agent/i);
    expect(call.temperature).toBe(0.2);
    expect(call.maxTokens).toBe(500);
  });

  it('honours a custom maxOutputTokens', async () => {
    stubStream('{"rational":"r","evidence":[],"summary":"s","confidence":0.1}');

    const { extractFromSource } = await import('../extractor.js');
    await extractFromSource(
      {} as import('ai').LanguageModel,
      { goal: 'g', sourceLabel: 'l', sourceContent: 'c', maxOutputTokens: 1200 },
    );

    const call = mockStreamText.mock.calls[0]![0] as { maxTokens?: number };
    expect(call.maxTokens).toBe(1200);
  });

  it('forwards abortSignal to streamText', async () => {
    stubStream('{"rational":"r","evidence":[],"summary":"s","confidence":0.0}');

    const { extractFromSource } = await import('../extractor.js');
    const ac = new AbortController();
    await extractFromSource(
      {} as import('ai').LanguageModel,
      { goal: 'g', sourceLabel: 'l', sourceContent: 'c' },
      ac.signal,
    );

    const call = mockStreamText.mock.calls[0]![0] as { abortSignal?: AbortSignal };
    expect(call.abortSignal).toBe(ac.signal);
  });
});
