import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_TEMPLATES,
  getTemplate,
  getDefaultTemplate,
} from '../systemPromptTemplates.js';

describe('BUILT_IN_TEMPLATES', () => {
  it('has exactly 5 built-in templates', () => {
    expect(BUILT_IN_TEMPLATES).toHaveLength(5);
  });

  it('every template has a non-empty id, name, description, prompt, and icon', () => {
    for (const t of BUILT_IN_TEMPLATES) {
      expect(t.id.length).toBeGreaterThan(0);
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.prompt.length).toBeGreaterThan(0);
      expect(t.icon.length).toBeGreaterThan(0);
    }
  });

  it('template ids are unique', () => {
    const ids = BUILT_IN_TEMPLATES.map((t) => t.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('includes code-reviewer template', () => {
    const t = BUILT_IN_TEMPLATES.find((x) => x.id === 'code-reviewer');
    expect(t).toBeDefined();
    expect(t?.name).toBe('Code Reviewer');
  });

  it('includes refactoring-partner template', () => {
    const t = BUILT_IN_TEMPLATES.find((x) => x.id === 'refactoring-partner');
    expect(t).toBeDefined();
  });

  it('includes debug-assistant template', () => {
    const t = BUILT_IN_TEMPLATES.find((x) => x.id === 'debug-assistant');
    expect(t).toBeDefined();
  });

  it('includes architect template', () => {
    const t = BUILT_IN_TEMPLATES.find((x) => x.id === 'architect');
    expect(t).toBeDefined();
  });

  it('includes concise template', () => {
    const t = BUILT_IN_TEMPLATES.find((x) => x.id === 'concise');
    expect(t).toBeDefined();
  });

  it('code-reviewer prompt mentions Security', () => {
    const t = getTemplate('code-reviewer');
    expect(t?.prompt).toContain('Security');
  });

  it('concise prompt is direct — no filler phrases', () => {
    const t = getTemplate('concise');
    expect(t?.prompt).toContain('concise');
  });
});

describe('getTemplate', () => {
  it('returns the matching template by id', () => {
    const t = getTemplate('debug-assistant');
    expect(t).toBeDefined();
    expect(t?.id).toBe('debug-assistant');
    expect(t?.name).toBe('Debug Assistant');
  });

  it('returns undefined for an unknown id', () => {
    expect(getTemplate('does-not-exist')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(getTemplate('')).toBeUndefined();
  });

  it('is case-sensitive — mixed case does not match', () => {
    expect(getTemplate('Code-Reviewer')).toBeUndefined();
    expect(getTemplate('CODE-REVIEWER')).toBeUndefined();
  });

  it('returns reference to the template object (not a copy)', () => {
    const t1 = getTemplate('architect');
    const t2 = getTemplate('architect');
    expect(t1).toBe(t2);
  });
});

describe('getDefaultTemplate', () => {
  it('returns undefined — blank slate by default', () => {
    expect(getDefaultTemplate()).toBeUndefined();
  });
});
