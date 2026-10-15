/**
 * registry.ts — unit tests for MemoryRegistry.
 * Mirrors skills/__tests__/registry.test.ts in shape.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryRegistry, __resetMemoryRegistryForTests } from '../registry.js';

function memoryMd(opts: {
  name: string;
  description?: string;
  pinned?: boolean;
  category?: string;
  source?: string;
  createdAt?: string;
  lastUsed?: string;
  body?: string;
}): string {
  const desc = opts.description ?? `${opts.name} description`;
  const fm = [
    '---',
    `name: ${opts.name}`,
    `description: ${JSON.stringify(desc)}`,
    'metadata:',
    `  pinned: ${opts.pinned ?? false}`,
    `  category: ${opts.category ?? 'fact'}`,
    `  source: ${opts.source ?? 'user-edit'}`,
    `  createdAt: ${opts.createdAt ?? '2026-06-03T12:00:00Z'}`,
  ];
  if (opts.lastUsed !== undefined) fm.push(`  lastUsed: ${opts.lastUsed}`);
  fm.push('---');
  const body = opts.body ?? `Body for ${opts.name}.`;
  return `${fm.join('\n')}\n${body}\n`;
}

let tmpBase: string;
let userDir: string;

beforeEach(() => {
  tmpBase = join(tmpdir(), `memory-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpBase, { recursive: true });
  userDir = join(tmpBase, 'user-home', '.uplnk', 'memory');
  __resetMemoryRegistryForTests();
});

afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true });
  __resetMemoryRegistryForTests();
});

describe('MemoryRegistry', () => {
  it('returns no memories when neither tier exists', () => {
    const reg = new MemoryRegistry({ projectDir: join(tmpBase, 'nonexistent'), userDir });
    expect(reg.list()).toHaveLength(0);
  });

  it('loads memories from the user tier', () => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'alpha.md'), memoryMd({ name: 'alpha' }));
    writeFileSync(join(userDir, 'beta.md'), memoryMd({ name: 'beta' }));

    const reg = new MemoryRegistry({ userDir });
    const names = reg.list().map((m) => m.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
    expect(reg.list().every((m) => m.scope === 'user')).toBe(true);
  });

  it('loads memories from the project tier', () => {
    const projectDir = join(tmpBase, 'proj');
    const projectMem = join(projectDir, '.uplnk', 'memory');
    mkdirSync(projectMem, { recursive: true });
    writeFileSync(join(projectMem, 'gamma.md'), memoryMd({ name: 'gamma' }));

    const reg = new MemoryRegistry({ projectDir, userDir });
    const def = reg.get('gamma');
    expect(def).toBeDefined();
    expect(def!.scope).toBe('project');
  });

  it('project-tier name collision overrides user tier', () => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'shared.md'), memoryMd({ name: 'shared', description: 'user version' }));

    const projectDir = join(tmpBase, 'proj');
    const projectMem = join(projectDir, '.uplnk', 'memory');
    mkdirSync(projectMem, { recursive: true });
    writeFileSync(join(projectMem, 'shared.md'), memoryMd({ name: 'shared', description: 'project version' }));

    const reg = new MemoryRegistry({ projectDir, userDir });
    const winner = reg.get('shared');
    expect(winner).toBeDefined();
    expect(winner!.description).toBe('project version');
    expect(winner!.scope).toBe('project');
  });

  it('get() returns undefined for unknown name', () => {
    const reg = new MemoryRegistry({ userDir });
    expect(reg.get('nope')).toBeUndefined();
  });

  it('parses pinned, category, lastUsed, body correctly', () => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(
      join(userDir, 'rich.md'),
      memoryMd({
        name: 'rich',
        description: 'user prefers pnpm',
        pinned: true,
        category: 'preference',
        source: 'slash',
        createdAt: '2026-05-01T00:00:00Z',
        lastUsed: '2026-06-01T00:00:00Z',
        body: 'They mentioned this several times.',
      }),
    );

    const reg = new MemoryRegistry({ userDir });
    const def = reg.get('rich')!;
    expect(def.pinned).toBe(true);
    expect(def.category).toBe('preference');
    expect(def.source).toBe('slash');
    // gray-matter parses ISO YAML scalars to Date; the schema normalizes them
    // back to a canonical .toISOString() form with millisecond precision.
    expect(def.createdAt).toBe('2026-05-01T00:00:00.000Z');
    expect(def.lastUsed).toBe('2026-06-01T00:00:00.000Z');
    expect(def.body).toBe('They mentioned this several times.');
  });

  it('skips files with invalid frontmatter without throwing', () => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'bad.md'), '---\nWrong_Field: nope\n---\nbad body\n');
    writeFileSync(join(userDir, 'good.md'), memoryMd({ name: 'good' }));

    const reg = new MemoryRegistry({ userDir });
    const names = reg.list().map((m) => m.name);
    expect(names).toContain('good');
    expect(names).not.toContain('bad');
  });

  it('skips files with name not matching kebab-case regex', () => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'bad-name.md'), memoryMd({ name: 'Bad_Name' }));
    writeFileSync(join(userDir, 'ok.md'), memoryMd({ name: 'ok' }));

    const reg = new MemoryRegistry({ userDir });
    expect(reg.get('ok')).toBeDefined();
    expect(reg.list().map((m) => m.name)).not.toContain('Bad_Name');
  });

  it('skips files with description longer than 280 chars', () => {
    mkdirSync(userDir, { recursive: true });
    const longDesc = 'x'.repeat(300);
    writeFileSync(join(userDir, 'huge.md'), memoryMd({ name: 'huge', description: longDesc }));
    writeFileSync(join(userDir, 'small.md'), memoryMd({ name: 'small' }));

    const reg = new MemoryRegistry({ userDir });
    expect(reg.get('huge')).toBeUndefined();
    expect(reg.get('small')).toBeDefined();
  });

  it('ignores non-.md files in the memory dir', () => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'notes.txt'), 'not a memory');
    writeFileSync(join(userDir, 'epsilon.md'), memoryMd({ name: 'epsilon' }));

    const reg = new MemoryRegistry({ userDir });
    expect(reg.list().map((m) => m.name)).toEqual(['epsilon']);
  });

  it('reload() picks up newly written files', async () => {
    mkdirSync(userDir, { recursive: true });
    const reg = new MemoryRegistry({ userDir });
    expect(reg.list()).toHaveLength(0);

    writeFileSync(join(userDir, 'late.md'), memoryMd({ name: 'late' }));
    await reg.reload();
    expect(reg.get('late')).toBeDefined();
  });

  it('reload() with new projectDir switches tier source', async () => {
    const reg = new MemoryRegistry({ userDir });
    expect(reg.list()).toHaveLength(0);

    const projectDir = join(tmpBase, 'proj2');
    const projectMem = join(projectDir, '.uplnk', 'memory');
    mkdirSync(projectMem, { recursive: true });
    writeFileSync(join(projectMem, 'projmem.md'), memoryMd({ name: 'projmem' }));

    await reg.reload(projectDir);
    const def = reg.get('projmem');
    expect(def).toBeDefined();
    expect(def!.scope).toBe('project');
  });

  it('list() returns memories in a deterministic shape', () => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'a.md'), memoryMd({ name: 'a' }));
    writeFileSync(join(userDir, 'b.md'), memoryMd({ name: 'b' }));
    const reg = new MemoryRegistry({ userDir });
    const all = reg.list();
    expect(all.length).toBe(2);
    for (const m of all) {
      expect(typeof m.name).toBe('string');
      expect(typeof m.description).toBe('string');
      expect(typeof m.pinned).toBe('boolean');
      expect(typeof m.sourcePath).toBe('string');
      expect(['user', 'project']).toContain(m.scope);
    }
  });
});
