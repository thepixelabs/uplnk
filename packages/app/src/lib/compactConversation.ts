/**
 * /compact helper — summarises the older portion of a conversation down to a
 * single synthetic message, freeing context window space while preserving
 * continuity.
 *
 * Split into two small pure functions so the ChatScreen wiring stays thin and
 * the unit tests can exercise selection and prompt assembly without a running
 * model:
 *
 *   splitForCompaction  — decides which messages get summarised vs kept
 *   summariseMessages   — calls generateText on the ACTIVE model and returns
 *                         the summary text (throws on provider error so the
 *                         caller can discard it without touching state)
 *
 * The `keepTail` count matches the product spec: keep the last 6 messages
 * untouched so the immediate back-and-forth context survives verbatim.
 */

import { generateText } from 'ai';
import type { CoreMessage, LanguageModel } from 'ai';
import type { Message } from '@uplnk/db';

/** Keep this many recent messages untouched; summarise everything before. */
export const COMPACT_KEEP_TAIL = 6;

/**
 * Minimum total messages required before /compact is allowed to run. Below
 * this threshold the spec says "Nothing to compact yet." — two turns of
 * summarise + keep is not worth the round-trip.
 */
export const COMPACT_MIN_MESSAGES = 8;

/** Visual marker wrapped around summary content so users can spot it at a glance. */
export function formatSummaryContent(summary: string): string {
  return `[\u2211 Summary: ${summary.trim()}]`;
}

export interface SplitResult {
  toSummarise: Message[];
  toKeep: Message[];
}

/**
 * Split a message list into the "summarise this" prefix and the "keep
 * verbatim" tail. Pure — no IO, no randomness, easy to test.
 */
export function splitForCompaction(
  messages: Message[],
  keepTail: number = COMPACT_KEEP_TAIL,
): SplitResult {
  if (messages.length <= keepTail) {
    return { toSummarise: [], toKeep: [...messages] };
  }
  const cut = messages.length - keepTail;
  return {
    toSummarise: messages.slice(0, cut),
    toKeep: messages.slice(cut),
  };
}

const SYSTEM_PROMPT = [
  'You are a conversation summariser. Given the earlier turns of a chat',
  'between a user and an assistant, produce a concise, faithful summary',
  'capturing: the user\u2019s goals, any decisions reached, facts established,',
  'code or file paths mentioned, and the current working state.',
  '',
  'Rules:',
  '- Write in the third person, past tense.',
  '- Prefer bullet points over prose when listing decisions or facts.',
  '- Do NOT invent details. If something is unclear, omit it.',
  '- Do NOT include the summary inside quotes or code fences.',
  '- Keep it under ~300 words.',
].join('\n');

/**
 * Ask the ACTIVE language model to summarise the given messages. Throws on
 * provider error — the caller is expected to leave state untouched and
 * surface the error to the user.
 */
export async function summariseMessages(
  model: LanguageModel,
  toSummarise: Message[],
): Promise<string> {
  // Render the messages as a single user turn rather than replaying them
  // as native roles: some local models (Ollama chat template edge cases)
  // misbehave when replayed with a system + many assistant turns, and the
  // summariser doesn't need true role fidelity — it just needs the text.
  const transcript = toSummarise
    .map((m) => {
      const role = m.role.toUpperCase();
      const body = (m.content ?? '').trim();
      return `${role}: ${body}`;
    })
    .join('\n\n');

  const prompt: CoreMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Summarise the following conversation so it can replace the original turns as context for a continuing session:\n\n${transcript}`,
    },
  ];

  const { text } = await generateText({
    model,
    messages: prompt,
    maxTokens: 800,
  });

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error('Summariser returned empty text');
  }
  return trimmed;
}
