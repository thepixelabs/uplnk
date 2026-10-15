/**
 * trigger — tests for the `@research <topic>` chat-trigger parsing and the
 * one-line status rendering of ResearchEvents used by ChatScreen.
 */

import { describe, it, expect } from 'vitest';
import { parseResearchTrigger, describeResearchEvent } from '../trigger.js';
import type { ResearchEvent } from '../runnerTypes.js';

describe('parseResearchTrigger', () => {
  it('extracts the topic from a leading @research mention', () => {
    expect(parseResearchTrigger('@research history of the handpan')).toBe(
      'history of the handpan',
    );
  });

  it('tolerates surrounding whitespace and multi-line topics', () => {
    expect(parseResearchTrigger('  @research foo\nbar  ')).toBe('foo\nbar');
  });

  it('returns null for non-trigger input', () => {
    expect(parseResearchTrigger('tell me about @research')).toBeNull();
    expect(parseResearchTrigger('@researcher check the auth flow')).toBeNull();
    expect(parseResearchTrigger('@research')).toBeNull();
    expect(parseResearchTrigger('@research   ')).toBeNull();
    expect(parseResearchTrigger('hello world')).toBeNull();
  });

  it('does not treat @researcher (the agent) as a research trigger', () => {
    // `@research…` requires whitespace after the literal token.
    expect(parseResearchTrigger('@researchers say hi')).toBeNull();
  });
});

describe('describeResearchEvent', () => {
  it('renders phase events as one-line statuses', () => {
    expect(describeResearchEvent({ type: 'plan:start' })).toBe('research: planning…');
    expect(
      describeResearchEvent({ type: 'plan:done', category: 'general', planSummary: 'x' }),
    ).toContain('general');
    expect(
      describeResearchEvent({ type: 'round:start', round: 2, queries: ['a', 'b'] }),
    ).toContain('round 2');
    expect(
      describeResearchEvent({
        type: 'final:done',
        report: 'r',
        sources: ['https://a', 'https://b'],
        durationMs: 10,
      }),
    ).toContain('2 sources');
  });

  it('returns null for report deltas (no status-line churn per token)', () => {
    expect(describeResearchEvent({ type: 'final:delta', delta: 'x' })).toBeNull();
  });

  it('handles every event variant without throwing', () => {
    const events: ResearchEvent[] = [
      { type: 'plan:start' },
      { type: 'plan:done', category: 'howto', planSummary: 's' },
      { type: 'round:start', round: 1, queries: ['q'] },
      { type: 'search:result', round: 1, query: 'q'.repeat(100), resultCount: 3 },
      { type: 'extract:start', round: 1, sourceUrl: 'https://example.com/a' },
      { type: 'extract:done', round: 1, sourceUrl: 'not a url', confidence: 0.5 },
      { type: 'synthesize:start', round: 1 },
      { type: 'synthesize:done', round: 1, reportLength: 1000 },
      { type: 'stop:check', round: 2, verdict: { stop: true, reason: 'done' } },
      { type: 'round:end', round: 1, durationMs: 5, newFindingsCount: 2 },
      { type: 'final:start' },
      { type: 'final:delta', delta: 'd' },
      { type: 'final:done', report: 'r', sources: [], durationMs: 5 },
      { type: 'error', phase: 'search', message: 'm'.repeat(100) },
      { type: 'aborted', reason: 'external' },
    ];
    for (const ev of events) {
      expect(() => describeResearchEvent(ev)).not.toThrow();
    }
  });
});
