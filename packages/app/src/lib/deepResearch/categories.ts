/**
 * classifyQuery + CATEGORY_TEMPLATES — research category routing (Phase D item 2.6).
 *
 * A cheap temp-0 micro-call classifies the user's query into one of five
 * categories: product, comparison, howto, factcheck, general. The runner
 * then appends CATEGORY_TEMPLATES[category] to the final-report prompt so
 * the synthesizer shapes the output to fit the category.
 *
 * The category prompt asks for a SINGLE word. We deliberately do NOT
 * require JSON here — temperature 0 + a one-word prompt is the cheapest
 * possible call and resilient to small whitespace/punctuation drift.
 *
 * If the response is anything we don't recognise, we fall back to
 * 'general'. We never throw: classification failure should not block a
 * research run.
 */

import { streamText } from 'ai';
import type { LanguageModel, CoreMessage } from 'ai';
import { CATEGORY_SYSTEM, CATEGORY_USER_TEMPLATE, CATEGORY_TEMPLATES } from './prompts.js';
import { RESEARCH_CATEGORIES } from './types.js';
import type { ResearchCategory } from './types.js';

export { CATEGORY_TEMPLATES };

const CATEGORY_MAX_OUTPUT_TOKENS = 20;

const CATEGORY_SET: ReadonlySet<ResearchCategory> = new Set(RESEARCH_CATEGORIES);

function normaliseToCategory(raw: string): ResearchCategory {
  // Strip whitespace, punctuation, Markdown decoration. The classifier system
  // prompt asks for one word; we extract the first run of letters and lowercase.
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[`*_"'.,!?]/g, '')
    .trim();

  // First token is the most likely candidate; some models still preface with
  // "category:" or "the answer is".
  const tokens = cleaned.split(/\s+/);
  for (const token of tokens) {
    if (CATEGORY_SET.has(token as ResearchCategory)) {
      return token as ResearchCategory;
    }
  }
  return 'general';
}

export async function classifyQuery(
  model: LanguageModel,
  query: string,
  signal?: AbortSignal,
): Promise<ResearchCategory> {
  const userPrompt = CATEGORY_USER_TEMPLATE.replace('{{QUERY}}', query);

  const messages: CoreMessage[] = [{ role: 'user', content: userPrompt }];

  const streamOptions: Parameters<typeof streamText>[0] = {
    model,
    system: CATEGORY_SYSTEM,
    messages,
    temperature: 0,
    maxTokens: CATEGORY_MAX_OUTPUT_TOKENS,
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
    return 'general';
  }

  return normaliseToCategory(raw);
}
