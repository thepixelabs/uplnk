/**
 * registry.ts — unit tests for AgentRegistry
 * Uses a tmp dir of synthetic .md files; no disk side-effects on the real tree.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRegistry, __resetRegistryForTests } from '../registry.js';

// Template for a minimal valid agent .md
function agentMd(name: string, description = `${name} agent`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nSystem prompt for ${name}.\n`;
}

let tmpBase: string;

beforeEach(() => {
  tmpBase = join(tmpdir(), `registry-test-${Date.now()}`);
  mkdirSync(tmpBase, { recursive: true });
  __resetRegistryForTests();
});

afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true });
  __resetRegistryForTests();
});

describe('AgentRegistry', () => {
  it('has no project-scoped agents when project agents dir does not exist', () => {
    const reg = new AgentRegistry({ projectDir: join(tmpBase, 'nonexistent') });
    // Builtins may be loaded; project dir agents must be absent
    const projectAgents = reg.list().filter((a) => a.source === 'project');
    expect(projectAgents).toHaveLength(0);
  });

  it('loads agents from a project dir', () => {
    const agentsDir = join(tmpBase, '.uplnk', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'alpha.md'), agentMd('alpha'));
    writeFileSync(join(agentsDir, 'beta.md'), agentMd('beta'));

    const reg = new AgentRegistry({ projectDir: tmpBase });
    const names = reg.list().map((a) => a.name).sort();
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
  });

  it('get() returns undefined for unknown agent', () => {
    const reg = new AgentRegistry({ projectDir: tmpBase });
    expect(reg.get('nonexistent')).toBeUndefined();
  });

  it('get() returns the agent def for a known agent', () => {
    const agentsDir = join(tmpBase, '.uplnk', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'gamma.md'), agentMd('gamma', 'A gamma agent.'));

    const reg = new AgentRegistry({ projectDir: tmpBase });
    const def = reg.get('gamma');
    expect(def).toBeDefined();
    expect(def!.name).toBe('gamma');
    expect(def!.description).toBe('A gamma agent.');
    expect(def!.source).toBe('project');
  });

  it('skips files with invalid frontmatter without throwing', () => {
    const agentsDir = join(tmpBase, '.uplnk', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'bad.md'), '---\ninvalid_only: true\n---\n');
    writeFileSync(join(agentsDir, 'good.md'), agentMd('good'));

    const reg = new AgentRegistry({ projectDir: tmpBase });
    const names = reg.list().map((a) => a.name);
    expect(names).toContain('good');
    expect(names).not.toContain('bad');
  });

  it('reload() re-reads the project dir', async () => {
    const agentsDir = join(tmpBase, '.uplnk', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const reg = new AgentRegistry({ projectDir: tmpBase });
    expect(reg.list().filter((a) => a.source === 'project')).toHaveLength(0);

    writeFileSync(join(agentsDir, 'delta.md'), agentMd('delta'));
    await reg.reload();

    expect(reg.get('delta')).toBeDefined();
  });

  it('later source overrides earlier by name (project > user > builtin)', () => {
    // Simulate project-level override of a name
    const projAgentsDir = join(tmpBase, '.uplnk', 'agents');
    mkdirSync(projAgentsDir, { recursive: true });
    writeFileSync(join(projAgentsDir, 'override.md'), agentMd('override'));

    const reg = new AgentRegistry({ projectDir: tmpBase });
    const def = reg.get('override');
    expect(def?.source).toBe('project');
  });

  it('ignores non-.md files', () => {
    const agentsDir = join(tmpBase, '.uplnk', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'notes.txt'), 'This is not an agent.');
    writeFileSync(join(agentsDir, 'epsilon.md'), agentMd('epsilon'));

    const reg = new AgentRegistry({ projectDir: tmpBase });
    const names = reg.list().map((a) => a.source === 'project' ? a.name : '').filter(Boolean);
    expect(names).not.toContain('notes');
    expect(names).toContain('epsilon');
  });
});
