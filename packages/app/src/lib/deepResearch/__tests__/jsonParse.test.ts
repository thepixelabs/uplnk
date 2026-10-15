/**
 * jsonParse.ts — unit tests for the tolerant LLM JSON parser.
 */

import { describe, it, expect } from 'vitest';
import { parseLlmJson, LlmJsonParseError } from '../jsonParse.js';

describe('parseLlmJson', () => {
  it('parses plain JSON object', () => {
    expect(parseLlmJson<{ a: number }>('{"a": 1}')).toEqual({ a: 1 });
  });

  it('parses plain JSON array', () => {
    expect(parseLlmJson<number[]>('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it('strips ```json ... ``` fence', () => {
    const raw = '```json\n{"a": 1}\n```';
    expect(parseLlmJson<{ a: number }>(raw)).toEqual({ a: 1 });
  });

  it('strips bare ``` ... ``` fence', () => {
    const raw = '```\n{"a": 1}\n```';
    expect(parseLlmJson<{ a: number }>(raw)).toEqual({ a: 1 });
  });

  it('strips prose before the JSON object', () => {
    const raw = 'Sure! Here is the JSON you asked for:\n{"a": 1}';
    expect(parseLlmJson<{ a: number }>(raw)).toEqual({ a: 1 });
  });

  it('strips prose after the JSON object', () => {
    const raw = '{"a": 1}\nLet me know if you need more!';
    expect(parseLlmJson<{ a: number }>(raw)).toEqual({ a: 1 });
  });

  it('strips prose on BOTH sides of the JSON object', () => {
    const raw = 'Of course! Here it is:\n```json\n{"a": 1, "b": [2, 3]}\n```\n\nHope that helps.';
    expect(parseLlmJson<{ a: number; b: number[] }>(raw)).toEqual({ a: 1, b: [2, 3] });
  });

  it('tolerates trailing commas before a closing brace', () => {
    const raw = '{"a": 1, "b": 2,}';
    expect(parseLlmJson<{ a: number; b: number }>(raw)).toEqual({ a: 1, b: 2 });
  });

  it('tolerates trailing commas before a closing bracket', () => {
    const raw = '[1, 2, 3,]';
    expect(parseLlmJson<number[]>(raw)).toEqual([1, 2, 3]);
  });

  it('tolerates trailing commas with surrounding whitespace and fences', () => {
    const raw = '```json\n{\n  "evidence": [\n    "a",\n    "b",\n  ],\n}\n```';
    expect(parseLlmJson<{ evidence: string[] }>(raw)).toEqual({ evidence: ['a', 'b'] });
  });

  it('throws LlmJsonParseError on truly broken JSON', () => {
    const raw = '{not valid json at all}';
    let caught: unknown = null;
    try {
      parseLlmJson(raw);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmJsonParseError);
    expect((caught as LlmJsonParseError).raw).toContain('not valid json');
    expect((caught as Error).message).toMatch(/failed to parse/i);
  });

  it('throws LlmJsonParseError when no JSON boundary is present', () => {
    expect(() => parseLlmJson('hello there')).toThrow(LlmJsonParseError);
  });

  it('returns the LlmJsonParseError name correctly', () => {
    try {
      parseLlmJson('nope');
    } catch (err) {
      expect((err as Error).name).toBe('LlmJsonParseError');
    }
  });
});
