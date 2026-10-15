/**
 * Chat-side helpers for the `@research <topic>` trigger.
 *
 * Kept out of ChatScreen so both the parse rule and the one-line status
 * rendering of ResearchEvents are unit-testable without Ink. ChatScreen
 * consumes these in its input routing (BEFORE agent-mention routing —
 * `research` is not a registered agent).
 */

import type { ResearchEvent } from './runnerTypes.js';

/**
 * Detect a leading `@research <topic>` in user input.
 * Returns the trimmed topic, or null when the input is not a research trigger.
 */
export function parseResearchTrigger(input: string): string | null {
  const m = /^@research\s+(\S[\s\S]*)$/.exec(input.trim());
  if (m === null) return null;
  const topic = m[1]!.trim();
  return topic.length > 0 ? topic : null;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function shortUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return truncate(url, 40);
  }
}

/**
 * One-line human-readable status for a ResearchEvent, or null for events
 * that should not update the inline status line (e.g. report text deltas).
 */
export function describeResearchEvent(ev: ResearchEvent): string | null {
  switch (ev.type) {
    case 'plan:start':
      return 'research: planning…';
    case 'plan:done':
      return `research: plan ready (${ev.category})`;
    case 'round:start':
      return `research: round ${ev.round} — searching (${ev.queries.length} ${ev.queries.length === 1 ? 'query' : 'queries'})`;
    case 'search:result':
      return `research: round ${ev.round} — "${truncate(ev.query, 40)}" → ${ev.resultCount} results`;
    case 'extract:start':
      return `research: round ${ev.round} — reading ${shortUrl(ev.sourceUrl)}`;
    case 'extract:done':
      return `research: round ${ev.round} — extracted ${shortUrl(ev.sourceUrl)}`;
    case 'synthesize:start':
      return `research: round ${ev.round} — synthesizing…`;
    case 'synthesize:done':
      return `research: round ${ev.round} — report at ${ev.reportLength} chars`;
    case 'stop:check':
      return ev.verdict.stop
        ? 'research: stopping — goal satisfied'
        : `research: round ${ev.round} — continuing`;
    case 'round:end':
      return `research: round ${ev.round} done (+${ev.newFindingsCount} findings)`;
    case 'final:start':
      return 'research: writing final report…';
    case 'final:delta':
      return null;
    case 'final:done':
      return `research: done — ${ev.sources.length} sources`;
    case 'error':
      return `research: ${ev.phase} error — ${truncate(ev.message, 60)}`;
    case 'aborted':
      return 'research: aborted';
  }
}
