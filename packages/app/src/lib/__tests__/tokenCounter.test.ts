import { describe, it, expect } from 'vitest';
import { approximateTokens, formatTokens, renderGaugeBar } from '../tokenCounter.js';

describe('approximateTokens', () => {
  it('returns 0 for empty strings', () => {
    expect(approximateTokens('')).toBe(0);
  });

  it('ceils chars/4 so tiny inputs round up to 1', () => {
    expect(approximateTokens('a')).toBe(1);
    expect(approximateTokens('abc')).toBe(1);
    expect(approximateTokens('abcd')).toBe(1);
    expect(approximateTokens('abcde')).toBe(2);
  });

  it('handles realistic sentences within the chars/4 approximation', () => {
    // "Hello, world!" is 13 chars → ceil(13/4) = 4 tokens.
    expect(approximateTokens('Hello, world!')).toBe(4);
  });
});

describe('formatTokens', () => {
  it('returns the raw number for counts under 1000', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1)).toBe('1');
    expect(formatTokens(812)).toBe('812');
    expect(formatTokens(999)).toBe('999');
  });

  it('uses one decimal between 1k and 10k', () => {
    expect(formatTokens(1000)).toBe('1.0k');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(9900)).toBe('9.9k');
  });

  it('rounds to whole k above 10k', () => {
    expect(formatTokens(10_000)).toBe('10k');
    expect(formatTokens(128_000)).toBe('128k');
    expect(formatTokens(200_499)).toBe('200k');
    expect(formatTokens(200_500)).toBe('201k');
  });
});

describe('renderGaugeBar', () => {
  it('returns empty string when total is missing or zero', () => {
    expect(renderGaugeBar(100, 0)).toBe('');
    expect(renderGaugeBar(100, -1)).toBe('');
  });

  it('renders a fully filled bar when used >= total', () => {
    expect(renderGaugeBar(10, 10, 4)).toBe('[▓▓▓▓]');
    expect(renderGaugeBar(20, 10, 4)).toBe('[▓▓▓▓]');
  });

  it('renders an empty bar when used is zero', () => {
    expect(renderGaugeBar(0, 10, 4)).toBe('[░░░░]');
  });

  it('renders a half-filled bar for 50% usage', () => {
    expect(renderGaugeBar(5, 10, 4)).toBe('[▓▓░░]');
  });

  it('rounds partial fills to the nearest cell', () => {
    // 3/10 over width 10 = 3 cells filled exactly
    expect(renderGaugeBar(3, 10, 10)).toBe('[▓▓▓░░░░░░░]');
  });
});
