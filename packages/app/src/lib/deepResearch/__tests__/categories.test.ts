/**
 * categories.ts — unit tests for classifyQuery + CATEGORY_TEMPLATES.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CATEGORY_TEMPLATES, RESEARCH_CATEGORIES } from '../index.js';
import type { ResearchCategory } from '../index.js';

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

describe('classifyQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps single-word "product" response', async () => {
    stubStream('product');
    const { classifyQuery } = await import('../categories.js');
    const cat = await classifyQuery(
      {} as import('ai').LanguageModel,
      'best mechanical keyboard under $150',
    );
    expect(cat).toBe('product');
  });

  it('maps "comparison" response', async () => {
    stubStream('comparison');
    const { classifyQuery } = await import('../categories.js');
    expect(
      await classifyQuery({} as import('ai').LanguageModel, 'postgres vs mysql'),
    ).toBe('comparison');
  });

  it('maps "howto" response', async () => {
    stubStream('howto');
    const { classifyQuery } = await import('../categories.js');
    expect(
      await classifyQuery({} as import('ai').LanguageModel, 'how do I configure nginx'),
    ).toBe('howto');
  });

  it('maps "factcheck" response', async () => {
    stubStream('factcheck');
    const { classifyQuery } = await import('../categories.js');
    expect(
      await classifyQuery({} as import('ai').LanguageModel, 'is coffee a carcinogen'),
    ).toBe('factcheck');
  });

  it('maps "general" response', async () => {
    stubStream('general');
    const { classifyQuery } = await import('../categories.js');
    expect(
      await classifyQuery({} as import('ai').LanguageModel, 'tell me about volcanoes'),
    ).toBe('general');
  });

  it('falls back to "general" on an unknown word', async () => {
    stubStream('miscellaneous');
    const { classifyQuery } = await import('../categories.js');
    expect(
      await classifyQuery({} as import('ai').LanguageModel, 'q'),
    ).toBe('general');
  });

  it('tolerates mixed case + punctuation + leading whitespace', async () => {
    stubStream('   Product.   ');
    const { classifyQuery } = await import('../categories.js');
    expect(
      await classifyQuery({} as import('ai').LanguageModel, 'q'),
    ).toBe('product');
  });

  it('extracts the category when the model adds a preface', async () => {
    stubStream('Category: comparison');
    const { classifyQuery } = await import('../categories.js');
    expect(
      await classifyQuery({} as import('ai').LanguageModel, 'q'),
    ).toBe('comparison');
  });

  it('uses temperature 0 and a tiny token budget', async () => {
    stubStream('general');
    const { classifyQuery } = await import('../categories.js');
    await classifyQuery({} as import('ai').LanguageModel, 'q');
    const call = mockStreamText.mock.calls[0]![0] as {
      temperature?: number;
      maxTokens?: number;
      system?: string;
    };
    expect(call.temperature).toBe(0);
    expect(call.maxTokens).toBe(20);
    expect(call.system).toMatch(/classify/i);
  });
});

describe('CATEGORY_TEMPLATES', () => {
  it('has a non-empty template for every ResearchCategory', () => {
    for (const cat of RESEARCH_CATEGORIES) {
      const template = CATEGORY_TEMPLATES[cat as ResearchCategory];
      expect(typeof template).toBe('string');
      expect(template.length).toBeGreaterThan(20);
    }
  });

  it('has all 5 expected keys and no extras', () => {
    const keys = Object.keys(CATEGORY_TEMPLATES).sort();
    expect(keys).toEqual(['comparison', 'factcheck', 'general', 'howto', 'product']);
  });
});
