/**
 * toolSelection — unit tests for the BM25-based per-turn tool picker.
 */

import { describe, it, expect } from 'vitest';
import { selectTools, scoreTool } from '../toolSelection.js';

const SAMPLE_TOOLS = {
  web_search: { description: 'Search the public internet for web pages and articles.' },
  git_status: { description: 'Show the working tree status of the current git repository.' },
  file_read: { description: 'Read the contents of a file from the local filesystem.' },
  file_write: { description: 'Write or overwrite a file on the local filesystem.' },
  bash: { description: 'Execute a shell command and return stdout and stderr.' },
};

describe('selectTools', () => {
  it('returns empty when the tool registry is empty', () => {
    const out = selectTools({ userMessage: 'anything', tools: {} });
    expect(out.selected).toEqual([]);
    expect(out.scores).toEqual({});
  });

  it('returns only alwaysAvailable + keyword-forced when userMessage is empty', () => {
    const out = selectTools({
      userMessage: '',
      tools: SAMPLE_TOOLS,
      alwaysAvailable: ['bash'],
      keywordHints: { search: ['web_search'] },
      topK: 5,
    });
    // Empty message → no keyword can match either, so only alwaysAvailable.
    expect(out.selected).toEqual(['bash']);
  });

  it('returns only alwaysAvailable + keyword-forced when userMessage is whitespace', () => {
    const out = selectTools({
      userMessage: '   \n\t  ',
      tools: SAMPLE_TOOLS,
      alwaysAvailable: ['bash'],
      topK: 5,
    });
    expect(out.selected).toEqual(['bash']);
  });

  it('ranks a clear topical match highest', () => {
    const out = selectTools({
      userMessage: 'search the web for sqlite-vec benchmarks',
      tools: SAMPLE_TOOLS,
      topK: 3,
    });
    expect(out.selected[0]).toBe('web_search');
    // git_status and file_read should not even appear (no matching terms).
    expect(out.selected).not.toContain('git_status');
  });

  it('ranks a name-anchored match above a description-only match', () => {
    // Note: per the spec tokenizer ([^a-z0-9_] split) underscores are NOT
    // separators, so a query term has to match a tool's full snake_case
    // identifier OR a space-separated name token to land on the name. Use
    // space-separated names here so the name boost is observable.
    const tools = {
      'find pages': { description: 'mentions search once in passing.' },
      'web search': { description: 'does an entirely unrelated task.' },
    };
    const out = selectTools({ userMessage: 'search', tools, topK: 2 });
    // 'web search' has the term in its name (twice via NAME_REPEAT); 'find
    // pages' has it only in description.
    expect(out.selected[0]).toBe('web search');
  });

  it('keyword hint force-includes a tool even when its score is zero', () => {
    const out = selectTools({
      userMessage: 'please commit my changes',
      tools: SAMPLE_TOOLS,
      keywordHints: { commit: ['git_status'] },
      topK: 0,
    });
    expect(out.selected).toContain('git_status');
  });

  it('keyword hint match is case-insensitive with word boundaries', () => {
    const out = selectTools({
      userMessage: 'Commit, please!',
      tools: SAMPLE_TOOLS,
      keywordHints: { commit: ['git_status'] },
      topK: 0,
    });
    expect(out.selected).toContain('git_status');
  });

  it('keyword hint does NOT match a substring inside a larger word', () => {
    const out = selectTools({
      userMessage: 'researching foundations',
      tools: SAMPLE_TOOLS,
      // "search" should NOT match inside "researching".
      keywordHints: { search: ['web_search'] },
      topK: 0,
    });
    expect(out.selected).not.toContain('web_search');
  });

  it('alwaysAvailable always appears even when irrelevant to the query', () => {
    const out = selectTools({
      userMessage: 'totally unrelated nonsense xyzzy',
      tools: SAMPLE_TOOLS,
      alwaysAvailable: ['bash'],
      topK: 3,
    });
    expect(out.selected).toContain('bash');
  });

  it('silently skips alwaysAvailable entries that do not exist in tools', () => {
    const out = selectTools({
      userMessage: 'search the web',
      tools: SAMPLE_TOOLS,
      alwaysAvailable: ['does_not_exist', 'bash'],
      topK: 2,
    });
    expect(out.selected).toContain('bash');
    expect(out.selected).not.toContain('does_not_exist');
  });

  it('dedupes when alwaysAvailable also tops the score ranking', () => {
    const out = selectTools({
      userMessage: 'search the web',
      tools: SAMPLE_TOOLS,
      alwaysAvailable: ['web_search'],
      topK: 5,
    });
    const occurrences = out.selected.filter((n) => n === 'web_search').length;
    expect(occurrences).toBe(1);
    expect(out.selected[0]).toBe('web_search');
  });

  it('topK=0 yields only alwaysAvailable + keyword-forced', () => {
    const out = selectTools({
      userMessage: 'search the web',
      tools: SAMPLE_TOOLS,
      alwaysAvailable: ['bash'],
      keywordHints: { search: ['web_search'] },
      topK: 0,
    });
    expect(out.selected).toEqual(['bash', 'web_search']);
  });

  it('topK=1 returns exactly one scored tool plus the forced sets', () => {
    const out = selectTools({
      userMessage: 'search the web for articles',
      tools: SAMPLE_TOOLS,
      alwaysAvailable: ['bash'],
      topK: 1,
    });
    // bash (always) + 1 scored (web_search).
    expect(out.selected).toHaveLength(2);
    expect(out.selected[0]).toBe('bash');
    expect(out.selected[1]).toBe('web_search');
  });

  it('topK greater than the corpus size returns at most the corpus size', () => {
    const out = selectTools({
      userMessage: 'file read write',
      tools: SAMPLE_TOOLS,
      topK: 999,
    });
    expect(out.selected.length).toBeLessThanOrEqual(Object.keys(SAMPLE_TOOLS).length);
  });

  it('stopword-only query yields an empty top-K (no scored tools)', () => {
    const out = selectTools({
      userMessage: 'the a an of to for with in on at',
      tools: SAMPLE_TOOLS,
      topK: 5,
    });
    expect(out.selected).toEqual([]);
  });

  it('is deterministic — same input always returns identical output', () => {
    const input = {
      userMessage: 'search the web and read a file',
      tools: SAMPLE_TOOLS,
      alwaysAvailable: ['bash'],
      keywordHints: { commit: ['git_status'] },
      topK: 3,
    };
    const a = selectTools(input);
    const b = selectTools(input);
    const c = selectTools(input);
    expect(a.selected).toEqual(b.selected);
    expect(b.selected).toEqual(c.selected);
    expect(a.scores).toEqual(b.scores);
  });

  it('breaks score ties by tool name ascending', () => {
    // Two tools with identical text differ only by name; tie should resolve alphabetically.
    const tools = {
      zebra: { description: 'compile the kernel module' },
      alpha: { description: 'compile the kernel module' },
      middle: { description: 'unrelated' },
    };
    const out = selectTools({ userMessage: 'compile kernel module', tools, topK: 2 });
    expect(out.selected).toEqual(['alpha', 'zebra']);
  });

  it('handles a tool with an empty description (name-only scoring still works)', () => {
    // The spec tokenizer treats underscores as part of a token, so the
    // matchable identifier here is the exact snake_case key.
    const tools = {
      database_query: { description: '' },
      other: { description: 'unrelated content here' },
    };
    const out = selectTools({ userMessage: 'run database_query now', tools, topK: 2 });
    expect(out.selected[0]).toBe('database_query');
  });

  it('tokenizes hostile names with dashes, dots, and spaces safely', () => {
    const tools = {
      'tool name with-dashes_and.dots': { description: 'finds search results' },
      benign: { description: 'unrelated' },
    };
    const out = selectTools({
      userMessage: 'name dashes dots',
      tools,
      topK: 2,
    });
    // Should not throw and the hostile-name tool should rank above benign.
    expect(out.selected[0]).toBe('tool name with-dashes_and.dots');
  });

  it('records scores only for top-K tools (alwaysAvailable / forced get 0)', () => {
    const out = selectTools({
      userMessage: 'search the web',
      tools: SAMPLE_TOOLS,
      alwaysAvailable: ['bash'],
      topK: 1,
    });
    expect(out.scores.bash).toBe(0);
    expect(out.scores.web_search).toBeGreaterThan(0);
  });

  it('does not include any tool whose BM25 score is zero', () => {
    const out = selectTools({
      userMessage: 'search',
      tools: SAMPLE_TOOLS,
      topK: 99,
    });
    // git_status / file_read / file_write / bash have no overlap with "search".
    expect(out.selected).toEqual(['web_search']);
  });
});

describe('scoreTool', () => {
  it('is pure — same args yield the same result', () => {
    const a = scoreTool('search the web', 'web_search', 'find pages on the internet');
    const b = scoreTool('search the web', 'web_search', 'find pages on the internet');
    const c = scoreTool('search the web', 'web_search', 'find pages on the internet');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('returns 0 for an empty query', () => {
    expect(scoreTool('', 'web_search', 'description')).toBe(0);
  });

  it('returns 0 for a stopword-only query', () => {
    expect(scoreTool('the a an of', 'web_search', 'find pages')).toBe(0);
  });

  it('returns 0 when neither name nor description match any query term', () => {
    expect(scoreTool('xyzzy plover', 'web_search', 'find pages')).toBe(0);
  });

  it('returns a positive number for a matching query', () => {
    const s = scoreTool('find internet pages', 'web_search', 'find pages on the internet');
    expect(s).toBeGreaterThan(0);
  });

  it('scores a name match higher than a single description match (name appears twice)', () => {
    const nameMatch = scoreTool('search', 'search', '');
    const descMatch = scoreTool('search', 'tool', 'search');
    expect(nameMatch).toBeGreaterThan(descMatch);
  });

  it('handles an empty description without throwing', () => {
    // Query has to match the snake_case token verbatim because the spec
    // tokenizer does not split on underscore.
    const s = scoreTool('run database_query', 'database_query', '');
    expect(s).toBeGreaterThan(0);
  });
});
