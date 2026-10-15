/**
 * registry.ts — unit tests for SkillRegistry.
 * Mirrors agents/__tests__/registry.test.ts in shape.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillRegistry, __resetSkillRegistryForTests } from '../registry.js';

function skillMd(name: string, description = `${name} skill`, extra = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\nBody for ${name}.\n`;
}

let tmpBase: string;

beforeEach(() => {
  tmpBase = join(tmpdir(), `skill-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpBase, { recursive: true });
  __resetSkillRegistryForTests();
});

afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true });
  __resetSkillRegistryForTests();
});

describe('SkillRegistry', () => {
  it('has no project-scoped skills when project skills dir does not exist', () => {
    const reg = new SkillRegistry({ projectDir: join(tmpBase, 'nonexistent') });
    const projectSkills = reg.list().filter((s) => s.source === 'project');
    expect(projectSkills).toHaveLength(0);
  });

  it('loads skills from a project dir', () => {
    const skillsDir = join(tmpBase, '.uplnk', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'alpha.md'), skillMd('alpha'));
    writeFileSync(join(skillsDir, 'beta.md'), skillMd('beta'));

    const reg = new SkillRegistry({ projectDir: tmpBase });
    const names = reg.list().map((s) => s.name).sort();
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
  });

  it('get() returns undefined for unknown skill', () => {
    const reg = new SkillRegistry({ projectDir: tmpBase });
    expect(reg.get('nonexistent')).toBeUndefined();
  });

  it('get() returns the skill def with parsed body for a known skill', () => {
    const skillsDir = join(tmpBase, '.uplnk', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'gamma.md'), skillMd('gamma', 'A gamma skill.'));

    const reg = new SkillRegistry({ projectDir: tmpBase });
    const def = reg.get('gamma');
    expect(def).toBeDefined();
    expect(def!.name).toBe('gamma');
    expect(def!.description).toBe('A gamma skill.');
    expect(def!.source).toBe('project');
    expect(def!.body).toBe('Body for gamma.');
  });

  it('skips files with invalid frontmatter without throwing', () => {
    const skillsDir = join(tmpBase, '.uplnk', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'bad.md'), '---\nName_WrongCase: true\n---\nbad body\n');
    writeFileSync(join(skillsDir, 'good.md'), skillMd('good'));

    const reg = new SkillRegistry({ projectDir: tmpBase });
    const names = reg.list().map((s) => s.name);
    expect(names).toContain('good');
    expect(names).not.toContain('bad');
  });

  it('reload() re-reads the project dir', async () => {
    const skillsDir = join(tmpBase, '.uplnk', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const reg = new SkillRegistry({ projectDir: tmpBase });
    expect(reg.list().filter((s) => s.source === 'project')).toHaveLength(0);

    writeFileSync(join(skillsDir, 'delta.md'), skillMd('delta'));
    await reg.reload();

    expect(reg.get('delta')).toBeDefined();
  });

  it('ignores non-.md files', () => {
    const skillsDir = join(tmpBase, '.uplnk', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'notes.txt'), 'This is not a skill.');
    writeFileSync(join(skillsDir, 'epsilon.md'), skillMd('epsilon'));

    const reg = new SkillRegistry({ projectDir: tmpBase });
    const projectNames = reg.list().filter((s) => s.source === 'project').map((s) => s.name);
    expect(projectNames).not.toContain('notes');
    expect(projectNames).toContain('epsilon');
  });

  describe('resolve()', () => {
    function setupRegistry(skills: { name: string; status?: 'draft' | 'published' }[]): SkillRegistry {
      const skillsDir = join(tmpBase, '.uplnk', 'skills');
      mkdirSync(skillsDir, { recursive: true });
      for (const { name, status } of skills) {
        const extra = status !== undefined ? `status: ${status}\n` : '';
        writeFileSync(join(skillsDir, `${name}.md`), skillMd(name, `${name} desc`, extra));
      }
      return new SkillRegistry({ projectDir: tmpBase });
    }

    it('resolves known published skills in input order', () => {
      const reg = setupRegistry([{ name: 'one' }, { name: 'two' }, { name: 'three' }]);
      const resolved = reg.resolve(['three', 'one']).map((s) => s.name);
      expect(resolved).toEqual(['three', 'one']);
    });

    it('skips unknown skill names', () => {
      const reg = setupRegistry([{ name: 'known' }]);
      const resolved = reg.resolve(['known', 'missing']).map((s) => s.name);
      expect(resolved).toEqual(['known']);
    });

    it('skips draft skills', () => {
      const reg = setupRegistry([
        { name: 'pub' },
        { name: 'wip', status: 'draft' },
      ]);
      const resolved = reg.resolve(['pub', 'wip']).map((s) => s.name);
      expect(resolved).toEqual(['pub']);
    });

    it('returns empty array for empty input', () => {
      const reg = setupRegistry([{ name: 'x' }]);
      expect(reg.resolve([])).toEqual([]);
    });
  });
});
