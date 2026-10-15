/**
 * parseNlSignal.ts — unit tests for natural-language memory signal regex set.
 */

import { describe, it, expect } from 'vitest';
import { detectNlMemorySignal } from '../parseNlSignal.js';

describe('detectNlMemorySignal — positive matches', () => {
  it('matches "from now on ..."', () => {
    const result = detectNlMemorySignal('From now on, use pnpm for installs.');
    expect(result).not.toBeNull();
    expect(result!.signal).toBe('from-now-on');
    expect(result!.save).toBe('From now on, use pnpm for installs.');
  });

  it('matches "always <directive verb>"', () => {
    const result = detectNlMemorySignal('You should always use TypeScript strict mode.');
    // "you should always" wins first
    expect(result).not.toBeNull();
    expect(['you-should-always', 'always-directive']).toContain(result!.signal);
  });

  it('matches bare "always use ..."', () => {
    const result = detectNlMemorySignal('Always use single quotes.');
    expect(result).not.toBeNull();
    expect(result!.signal).toBe('always-directive');
  });

  it('matches "remember that ..."', () => {
    const result = detectNlMemorySignal('Just remember that I prefer dark mode.');
    expect(result).not.toBeNull();
    expect(result!.signal).toBe('remember-that');
  });

  it('matches "next time ..."', () => {
    const result = detectNlMemorySignal('Next time, ask before refactoring.');
    expect(result).not.toBeNull();
    expect(result!.signal).toBe('next-time');
  });

  it('matches "I prefer ..."', () => {
    const result = detectNlMemorySignal('I prefer Tailwind over plain CSS.');
    expect(result).not.toBeNull();
    expect(result!.signal).toBe('i-prefer');
  });

  it('matches "I like to <directive verb>"', () => {
    const result = detectNlMemorySignal('I like to format with two-space indents.');
    expect(result).not.toBeNull();
    expect(result!.signal).toBe('i-like-directive');
  });

  it('matches "stop using ..."', () => {
    const result = detectNlMemorySignal('Please stop using emojis in commits.');
    expect(result).not.toBeNull();
    expect(result!.signal).toBe('stop-doing');
  });

  it('matches "don\'t ever ..."', () => {
    const result = detectNlMemorySignal("Don't ever amend my commits.");
    expect(result).not.toBeNull();
    expect(result!.signal).toBe('dont-ever');
  });

  it('matches "don\'t ever again ..."', () => {
    const result = detectNlMemorySignal("Don't ever again push to main.");
    expect(result).not.toBeNull();
    expect(result!.signal).toBe('dont-ever');
  });

  it('matches "you should always ..."', () => {
    const result = detectNlMemorySignal('You should always run lint before commit.');
    expect(result).not.toBeNull();
    expect(result!.signal).toBe('you-should-always');
  });

  it('matches "in the future ..."', () => {
    const result = detectNlMemorySignal('In the future, default to long-form flags.');
    expect(result).not.toBeNull();
    expect(result!.signal).toBe('in-the-future');
  });

  it('matches "please always <directive verb>"', () => {
    const result = detectNlMemorySignal('Please always include a test for changes.');
    expect(result).not.toBeNull();
    expect(result!.signal).toBe('please-always');
  });

  it('matches "please never ..."', () => {
    const result = detectNlMemorySignal('Please never delete files without asking.');
    expect(result).not.toBeNull();
    expect(result!.signal).toBe('please-never');
  });
});

describe('detectNlMemorySignal — negative cases (no false positives)', () => {
  it('rejects "always sunny" (no directive verb)', () => {
    expect(detectNlMemorySignal("It's always sunny in Philadelphia.")).toBeNull();
  });

  it('rejects "I like cats" (no directive verb)', () => {
    expect(detectNlMemorySignal('I like cats.')).toBeNull();
  });

  it('rejects "I like dogs more than cats" (no directive verb)', () => {
    expect(detectNlMemorySignal('I like dogs more than cats.')).toBeNull();
  });

  it('rejects "the wind always blows" (always + non-directive)', () => {
    expect(detectNlMemorySignal('The wind always blows from the south.')).toBeNull();
  });

  it('rejects "please always" without a directive verb', () => {
    expect(detectNlMemorySignal('Please always be kind.')).toBeNull();
  });

  it('rejects unrelated chatty input', () => {
    expect(detectNlMemorySignal('Hi! How are you doing today?')).toBeNull();
    expect(detectNlMemorySignal('Can you summarize this file?')).toBeNull();
  });

  it('returns null on empty / whitespace input', () => {
    expect(detectNlMemorySignal('')).toBeNull();
    expect(detectNlMemorySignal('   ')).toBeNull();
  });
});

describe('detectNlMemorySignal — sentence isolation', () => {
  it('returns only the matching sentence in multi-sentence input', () => {
    const result = detectNlMemorySignal(
      'I just finished lunch. From now on, prefer pnpm. Also the weather is nice.',
    );
    expect(result).not.toBeNull();
    expect(result!.save).toBe('From now on, prefer pnpm.');
  });

  it('matches the first signal across sentences', () => {
    const result = detectNlMemorySignal(
      'I prefer pnpm. Always use single quotes.',
    );
    expect(result).not.toBeNull();
    expect(result!.signal).toBe('i-prefer');
  });

  it('isolates a sentence with a trailing fragment (no terminal punctuation)', () => {
    const result = detectNlMemorySignal('Hello. From now on prefer pnpm');
    expect(result).not.toBeNull();
    expect(result!.save).toBe('From now on prefer pnpm');
  });

  it('handles ? and ! terminators', () => {
    const result = detectNlMemorySignal('Are you ok? Please always include tests!');
    expect(result).not.toBeNull();
    expect(result!.save).toBe('Please always include tests!');
  });
});
