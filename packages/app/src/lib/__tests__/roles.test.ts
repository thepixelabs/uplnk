import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_ROLES,
  getRole,
  getDefaultRole,
} from '../roles.js';

describe('BUILT_IN_ROLES', () => {
  it('has exactly 5 built-in roles', () => {
    expect(BUILT_IN_ROLES).toHaveLength(5);
  });

  it('every role has a non-empty id, name, description, prompt, and icon', () => {
    for (const t of BUILT_IN_ROLES) {
      expect(t.id.length).toBeGreaterThan(0);
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.prompt.length).toBeGreaterThan(0);
      expect(t.icon.length).toBeGreaterThan(0);
    }
  });

  it('role ids are unique', () => {
    const ids = BUILT_IN_ROLES.map((t) => t.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('includes code-reviewer role', () => {
    const t = BUILT_IN_ROLES.find((x) => x.id === 'code-reviewer');
    expect(t).toBeDefined();
    expect(t?.name).toBe('Code Reviewer');
  });

  it('includes refactoring-partner role', () => {
    const t = BUILT_IN_ROLES.find((x) => x.id === 'refactoring-partner');
    expect(t).toBeDefined();
  });

  it('includes debug-assistant role', () => {
    const t = BUILT_IN_ROLES.find((x) => x.id === 'debug-assistant');
    expect(t).toBeDefined();
  });

  it('includes architect role', () => {
    const t = BUILT_IN_ROLES.find((x) => x.id === 'architect');
    expect(t).toBeDefined();
  });

  it('includes concise role', () => {
    const t = BUILT_IN_ROLES.find((x) => x.id === 'concise');
    expect(t).toBeDefined();
  });

  it('code-reviewer prompt mentions Security', () => {
    const t = getRole('code-reviewer');
    expect(t?.prompt).toContain('Security');
  });

  it('concise prompt is direct — no filler phrases', () => {
    const t = getRole('concise');
    expect(t?.prompt).toContain('concise');
  });
});

describe('getRole', () => {
  it('returns the matching role by id', () => {
    const t = getRole('debug-assistant');
    expect(t).toBeDefined();
    expect(t?.id).toBe('debug-assistant');
    expect(t?.name).toBe('Debug Assistant');
  });

  it('returns undefined for an unknown id', () => {
    expect(getRole('does-not-exist')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(getRole('')).toBeUndefined();
  });

  it('is case-sensitive — mixed case does not match', () => {
    expect(getRole('Code-Reviewer')).toBeUndefined();
    expect(getRole('CODE-REVIEWER')).toBeUndefined();
  });

  it('returns reference to the role object (not a copy)', () => {
    const t1 = getRole('architect');
    const t2 = getRole('architect');
    expect(t1).toBe(t2);
  });
});

describe('getDefaultRole', () => {
  it('returns undefined — blank slate by default', () => {
    expect(getDefaultRole()).toBeUndefined();
  });
});
