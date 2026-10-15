/**
 * store.ts — unit tests for MemoryStore.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../store.js';
import { parseMemoryFile } from '../validate.js';
import { MemoryRegistry } from '../registry.js';

let tmpBase: string;
let userDir: string;
let projectDir: string;

beforeEach(() => {
  tmpBase = join(tmpdir(), `memory-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  userDir = join(tmpBase, 'user-home', '.uplnk', 'memory');
  projectDir = join(tmpBase, 'proj');
  mkdirSync(tmpBase, { recursive: true });
});

afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

function readAllNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
}

describe('MemoryStore.write', () => {
  it('persists a memory to the user tier with kebab-case name', () => {
    const store = new MemoryStore({ userDir });
    const def = store.write({ description: 'User prefers pnpm over npm always', scope: 'user' });
    expect(def.name).toBe('user-prefers-pnpm-over-npm-always');
    expect(def.scope).toBe('user');
    expect(existsSync(def.sourcePath)).toBe(true);
  });

  it('writes valid YAML frontmatter that round-trips through parseMemoryFile', () => {
    const store = new MemoryStore({ userDir });
    const def = store.write({
      description: 'I prefer concise commits',
      scope: 'user',
      category: 'preference',
      source: 'slash',
      body: 'They said so in the kickoff.',
    });
    const raw = readFileSync(def.sourcePath, 'utf8');
    const parsed = parseMemoryFile(raw, def.sourcePath, 'user');
    expect(parsed.description).toBe('I prefer concise commits');
    expect(parsed.category).toBe('preference');
    expect(parsed.source).toBe('slash');
    expect(parsed.body).toBe('They said so in the kickoff.');
  });

  it('defaults category to "fact" and pinned to false', () => {
    const store = new MemoryStore({ userDir });
    const def = store.write({ description: 'Capital of France is Paris', scope: 'user' });
    expect(def.category).toBe('fact');
    expect(def.pinned).toBe(false);
  });

  it('auto-pins memories with category=identity', () => {
    const store = new MemoryStore({ userDir });
    const def = store.write({
      description: 'User is named Maya',
      scope: 'user',
      category: 'identity',
    });
    expect(def.pinned).toBe(true);
  });

  it('respects an explicit pinned: false even on identity category', () => {
    const store = new MemoryStore({ userDir });
    const def = store.write({
      description: 'User is named Maya',
      scope: 'user',
      category: 'identity',
      pinned: false,
    });
    expect(def.pinned).toBe(false);
  });

  it('appends a ULID suffix on name collision', () => {
    const store = new MemoryStore({ userDir });
    const first = store.write({ description: 'Always use bun', scope: 'user' });
    const second = store.write({ description: 'Always use bun', scope: 'user' });
    expect(first.name).toBe('always-use-bun');
    expect(second.name).toMatch(/^always-use-bun-[a-z0-9]{6}$/);
    expect(readAllNames(userDir)).toHaveLength(2);
  });

  it('cleans non-alphanum characters out of the name', () => {
    const store = new MemoryStore({ userDir });
    const def = store.write({ description: "Don't ever use npm install --force!", scope: 'user' });
    expect(def.name).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('throws when description is empty', () => {
    const store = new MemoryStore({ userDir });
    expect(() => store.write({ description: '   ', scope: 'user' })).toThrow();
  });

  it('throws when description exceeds 280 chars', () => {
    const store = new MemoryStore({ userDir });
    expect(() => store.write({ description: 'x'.repeat(300), scope: 'user' })).toThrow();
  });

  it('throws when scope is project but no projectDir was set', () => {
    const store = new MemoryStore({ userDir });
    expect(() => store.write({ description: 'something', scope: 'project' })).toThrow();
  });

  it('writes to project tier when scope is project', () => {
    const store = new MemoryStore({ userDir, projectDir });
    const def = store.write({ description: 'Repo uses pnpm workspaces', scope: 'project' });
    expect(def.sourcePath).toContain(join(projectDir, '.uplnk', 'memory'));
    expect(existsSync(def.sourcePath)).toBe(true);
  });

  it('atomic write leaves no .tmp file behind on success', () => {
    const store = new MemoryStore({ userDir });
    store.write({ description: 'Random fact', scope: 'user' });
    const entries = readdirSync(userDir);
    expect(entries.every((f) => !f.includes('.tmp.'))).toBe(true);
  });

  it('sets createdAt from injected clock', () => {
    const fixed = new Date('2026-01-15T10:00:00Z');
    const store = new MemoryStore({ userDir, now: () => fixed });
    const def = store.write({ description: 'A fact', scope: 'user' });
    expect(def.createdAt).toBe('2026-01-15T10:00:00.000Z');
  });
});

describe('MemoryStore.setPinned', () => {
  it('toggles pinned and persists', () => {
    const store = new MemoryStore({ userDir });
    const def = store.write({ description: 'Eats lunch at noon', scope: 'user' });
    expect(def.pinned).toBe(false);

    const after = store.setPinned(def.name, true);
    expect(after).not.toBeNull();
    expect(after!.pinned).toBe(true);

    const reg = new MemoryRegistry({ userDir });
    expect(reg.get(def.name)!.pinned).toBe(true);
  });

  it('returns null for unknown name', () => {
    const store = new MemoryStore({ userDir });
    expect(store.setPinned('nope', true)).toBeNull();
  });
});

describe('MemoryStore.updateLastUsed', () => {
  it('writes a fresh lastUsed timestamp', () => {
    const t0 = new Date('2026-01-15T10:00:00Z');
    const t1 = new Date('2026-02-20T08:00:00Z');
    let nowVal = t0;
    const store = new MemoryStore({ userDir, now: () => nowVal });
    const def = store.write({ description: 'Likes blueberries', scope: 'user' });
    expect(def.lastUsed).toBeUndefined();

    nowVal = t1;
    const after = store.updateLastUsed(def.name);
    expect(after!.lastUsed).toBe('2026-02-20T08:00:00.000Z');
  });

  it('returns null for unknown name', () => {
    const store = new MemoryStore({ userDir });
    expect(store.updateLastUsed('nope')).toBeNull();
  });
});

describe('MemoryStore.delete', () => {
  it('removes the file and returns true', () => {
    const store = new MemoryStore({ userDir });
    const def = store.write({ description: 'Temporary thought', scope: 'user' });
    expect(existsSync(def.sourcePath)).toBe(true);
    expect(store.delete(def.name)).toBe(true);
    expect(existsSync(def.sourcePath)).toBe(false);
  });

  it('returns false for unknown name', () => {
    const store = new MemoryStore({ userDir });
    expect(store.delete('does-not-exist')).toBe(false);
  });

  it('prefers project tier when name exists in both', () => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(
      join(userDir, 'overlap.md'),
      '---\nname: overlap\ndescription: "u"\nmetadata:\n  pinned: false\n  category: fact\n  source: user-edit\n  createdAt: 2026-01-01T00:00:00Z\n---\n',
    );
    const projectMem = join(projectDir, '.uplnk', 'memory');
    mkdirSync(projectMem, { recursive: true });
    writeFileSync(
      join(projectMem, 'overlap.md'),
      '---\nname: overlap\ndescription: "p"\nmetadata:\n  pinned: false\n  category: fact\n  source: user-edit\n  createdAt: 2026-01-01T00:00:00Z\n---\n',
    );

    const store = new MemoryStore({ userDir, projectDir });
    expect(store.delete('overlap')).toBe(true);
    expect(existsSync(join(projectMem, 'overlap.md'))).toBe(false);
    expect(existsSync(join(userDir, 'overlap.md'))).toBe(true);
  });
});

describe('MemoryStore name generation edge cases', () => {
  it('uses fallback "memory" name when description has no alpha-num content', () => {
    const store = new MemoryStore({ userDir });
    const def = store.write({ description: '!!! ??? ...', scope: 'user' });
    expect(def.name === 'memory' || def.name.startsWith('memory-')).toBe(true);
  });

  it('truncates to six words', () => {
    const store = new MemoryStore({ userDir });
    const def = store.write({
      description: 'one two three four five six seven eight nine',
      scope: 'user',
    });
    expect(def.name).toBe('one-two-three-four-five-six');
  });
});
