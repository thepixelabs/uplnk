/**
 * parseSlashCommand.ts — unit tests for /remember + remember: detection.
 */

import { describe, it, expect } from 'vitest';
import { parseRememberCommand } from '../parseSlashCommand.js';

describe('parseRememberCommand', () => {
  it('matches "/remember <text>"', () => {
    expect(parseRememberCommand('/remember I prefer pnpm')).toEqual({ save: 'I prefer pnpm' });
  });

  it('matches "/Remember <text>" case-insensitively', () => {
    expect(parseRememberCommand('/Remember Use TypeScript')).toEqual({ save: 'Use TypeScript' });
  });

  it('matches "/REMEMBER <text>"', () => {
    expect(parseRememberCommand('/REMEMBER tabs not spaces')).toEqual({ save: 'tabs not spaces' });
  });

  it('matches "remember: <text>"', () => {
    expect(parseRememberCommand('remember: I prefer bun')).toEqual({ save: 'I prefer bun' });
  });

  it('matches "Remember: <text>" case-insensitively', () => {
    expect(parseRememberCommand('Remember: hello')).toEqual({ save: 'hello' });
  });

  it('matches "REMEMBER: <text>"', () => {
    expect(parseRememberCommand('REMEMBER: shouting works too')).toEqual({ save: 'shouting works too' });
  });

  it('trims leading and trailing whitespace from the captured text', () => {
    expect(parseRememberCommand('/remember     hello world    ')).toEqual({ save: 'hello world' });
    expect(parseRememberCommand('remember:    spaced    ')).toEqual({ save: 'spaced' });
  });

  it('tolerates leading whitespace before the command', () => {
    expect(parseRememberCommand('   /remember thing')).toEqual({ save: 'thing' });
    expect(parseRememberCommand('   remember: thing')).toEqual({ save: 'thing' });
  });

  it('returns null when text after "/remember" is empty', () => {
    expect(parseRememberCommand('/remember')).toBeNull();
    expect(parseRememberCommand('/remember    ')).toBeNull();
  });

  it('returns null when text after "remember:" is empty', () => {
    expect(parseRememberCommand('remember:')).toBeNull();
    expect(parseRememberCommand('remember:   ')).toBeNull();
  });

  it('returns null for unrelated input', () => {
    expect(parseRememberCommand('hello world')).toBeNull();
    expect(parseRememberCommand('I want to remember something but no prefix')).toBeNull();
    expect(parseRememberCommand('this remembers nothing')).toBeNull();
  });

  it('returns null for partial-match like "/rememberx"', () => {
    expect(parseRememberCommand('/rememberx foo')).toBeNull();
  });

  it('returns null for "remember" without the colon', () => {
    expect(parseRememberCommand('remember the milk')).toBeNull();
  });

  it('preserves internal punctuation in the captured text', () => {
    expect(parseRememberCommand('/remember user: maya, role: tech lead')).toEqual({
      save: 'user: maya, role: tech lead',
    });
  });

  it('matches multi-line captured text', () => {
    expect(parseRememberCommand('/remember line one\nline two')).toEqual({
      save: 'line one\nline two',
    });
  });

  it('returns null for empty string', () => {
    expect(parseRememberCommand('')).toBeNull();
  });
});
