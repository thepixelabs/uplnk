/**
 * detectNlMemorySignal — detect a "this is a durable preference" phrase in
 * free-form user input, WITHOUT calling an LLM. When matched, the containing
 * sentence is returned for explicit save (Wave 2 will surface it as a
 * confirmation prompt before persisting).
 *
 * Each regex is anchored on a load-bearing phrase. Verb constraints on
 * "always" / "I like" / "please always" suppress chatty false positives
 * ("it's always sunny", "I like cats") that have nothing to do with
 * remembered preferences.
 *
 * Returns the FULL sentence containing the match (split on `[.!?]` or message
 * boundary), plus the canonical signal name for telemetry.
 *
 * To extend: add another `{ name, pattern }` entry to MEMORY_SIGNALS. Keep
 * patterns case-insensitive (`i` flag) and word-boundary-anchored.
 */

export interface NlMemorySignal {
  /** The sentence containing the matched phrase, trimmed. */
  save: string;
  /** Canonical signal name — useful for telemetry / UI confirmation copy. */
  signal: string;
}

interface SignalSpec {
  name: string;
  pattern: RegExp;
}

// Verb whitelist for the "soft" signals (always, I like, please always|never).
// Anything not directly followed by a directive verb is noise.
const DIRECTIVE_VERB = '(?:use|do|prefer|return|answer|respond|reply|treat|consider|skip|avoid|include|exclude|format|call|name|address|refer|assume|default|pick|choose)';

/**
 * Order matters — narrower patterns must come BEFORE their broader supersets so
 * the more specific signal name wins for telemetry (e.g. "please always X" must
 * report `please-always`, not `always-directive`; "you should always" must
 * report `you-should-always`, not `always-directive`).
 */
export const MEMORY_SIGNALS: readonly SignalSpec[] = [
  { name: 'from-now-on', pattern: /\bfrom now on\b/i },
  { name: 'remember-that', pattern: /\bremember that\b/i },
  { name: 'next-time', pattern: /\bnext time\b/i },
  { name: 'in-the-future', pattern: /\bin the future\b/i },
  { name: 'you-should-always', pattern: /\byou should always\b/i },
  { name: 'please-always', pattern: new RegExp(`\\bplease always\\s+${DIRECTIVE_VERB}\\b`, 'i') },
  { name: 'please-never', pattern: /\bplease never\b/i },
  { name: 'always-directive', pattern: new RegExp(`\\balways\\s+${DIRECTIVE_VERB}\\b`, 'i') },
  { name: 'i-prefer', pattern: /\bI prefer\b/i },
  { name: 'i-like-directive', pattern: new RegExp(`\\bI like (?:it )?(?:when |to )?${DIRECTIVE_VERB}\\b`, 'i') },
  { name: 'stop-doing', pattern: /\bstop (?:doing|using|including|excluding|saying)\b/i },
  { name: 'dont-ever', pattern: /\bdon't ever(?: again)?\b/i },
];

const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

export function detectNlMemorySignal(input: string): NlMemorySignal | null {
  if (typeof input !== 'string' || input.trim().length === 0) return null;
  const sentences = splitSentences(input);
  for (const sentence of sentences) {
    for (const spec of MEMORY_SIGNALS) {
      if (spec.pattern.test(sentence)) {
        return { save: sentence.trim(), signal: spec.name };
      }
    }
  }
  return null;
}

function splitSentences(input: string): string[] {
  // Split on terminal punctuation followed by whitespace. Keep trailing fragment
  // (no terminal punctuation) as its own sentence.
  return input
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
