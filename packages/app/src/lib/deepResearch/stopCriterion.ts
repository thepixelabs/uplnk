/**
 * shouldStopResearch — per-round LLM stop decision (Phase D item 2.7).
 *
 * After each research round, the runner calls this helper with the goal and
 * the evolving report. The model returns {stop: bool, reason: string}; the
 * runner respects `stop=true` and surfaces `reason` to the UI.
 *
 * Quick-path: if round < 2 we short-circuit to `stop: false` WITHOUT calling
 * the LLM. This matches Odysseus's "min 2 rounds before asking" convention —
 * a one-round report rarely has enough material for an informed yes, and the
 * micro-call cost (~1 round-trip) is wasted.
 *
 * The micro-call goes through generateStructured (lib/structured.ts): JSON
 * mode + schema validation + corrective retries + text fallback. On total
 * failure we default to `stop: false, reason: 'parse-failed'`. The
 * conservative posture is to KEEP RESEARCHING when we can't read the verdict;
 * the round cap upstream catches runaway loops.
 */

import type { LanguageModel, CoreMessage } from 'ai';
import { z } from 'zod';
import { wrapUntrusted } from '../promptSecurity.js';
import { generateStructured } from '../structured.js';
import { STOP_SYSTEM, STOP_USER_TEMPLATE } from './prompts.js';
import type { StopVerdict } from './types.js';

export interface StopInput {
  goal: string;
  evolvingReport: string;
  round: number;
}

const MIN_ROUNDS_BEFORE_ASKING = 2;
const STOP_MAX_OUTPUT_TOKENS = 128;

/**
 * Deliberately lenient: any object shape passes and coerceVerdict handles
 * the sloppy variants small models emit (`"true"` strings, missing fields).
 * A strict schema here would burn retry round-trips on a micro-call whose
 * failure mode is already safe (`stop: false`).
 */
const RawVerdictSchema = z.object({
  stop: z.unknown().optional(),
  reason: z.unknown().optional(),
});

type RawVerdict = z.infer<typeof RawVerdictSchema>;

function coerceVerdict(raw: RawVerdict): StopVerdict {
  const stop = raw.stop === true || raw.stop === 'true';
  const reason =
    typeof raw.reason === 'string' && raw.reason.trim().length > 0
      ? raw.reason
      : stop
        ? 'model returned stop=true'
        : 'model returned stop=false';
  return { stop, reason };
}

export async function shouldStopResearch(
  model: LanguageModel,
  input: StopInput,
  signal?: AbortSignal,
): Promise<StopVerdict> {
  const { goal, evolvingReport, round } = input;

  // Quick-path: do not pay for the micro-call below the minimum round count.
  if (round < MIN_ROUNDS_BEFORE_ASKING) {
    return {
      stop: false,
      reason: `round ${round} below min-rounds threshold (${MIN_ROUNDS_BEFORE_ASKING})`,
    };
  }

  const userPrompt = STOP_USER_TEMPLATE
    .replace('{{GOAL}}', goal)
    .replace('{{ROUND}}', String(round));

  const wrappedReport = wrapUntrusted({
    label: 'evolving-report',
    content: evolvingReport,
  });

  const messages: CoreMessage[] = [
    { role: 'user', content: userPrompt },
    wrappedReport,
  ];

  try {
    const { object } = await generateStructured({
      model,
      schema: RawVerdictSchema,
      messages,
      system: STOP_SYSTEM,
      temperature: 0.1,
      maxTokens: STOP_MAX_OUTPUT_TOKENS,
      ...(signal !== undefined ? { abortSignal: signal } : {}),
    });
    return coerceVerdict(object);
  } catch (err) {
    if (signal?.aborted) throw err;
    return { stop: false, reason: 'parse-failed' };
  }
}
