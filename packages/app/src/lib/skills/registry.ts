/**
 * SkillRegistry — discovers, parses, and caches skill .md files.
 *
 * Discovery order (later overrides earlier by `name`):
 *   1. packages/app/src/lib/skills/builtins/*.md  (source: 'builtin')
 *   2. ~/.uplnk/skills/*.md                        (source: 'user')
 *   3. <projectDir>/.uplnk/skills/*.md             (source: 'project')
 *
 * Files that fail validation are skipped with console.warn — registry never throws.
 * Mirrors AgentRegistry exactly. Future Phase C may add a 4th tier for
 * auto-learned skills under ~/.uplnk/skills/learned/.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseSkillFile } from './validate.js';
import type { SkillDef, ISkillRegistry } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BUILTINS_DIR = join(__dirname, 'builtins');
const USER_DIR = join(homedir(), '.uplnk', 'skills');

function loadSkillsFromDir(
  dir: string,
  source: 'builtin' | 'user' | 'project' | 'learned',
  into: Map<string, SkillDef>,
): void {
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => extname(f) === '.md');
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      const raw = readFileSync(fullPath, 'utf8');
      const def = parseSkillFile(raw, fullPath, source);
      into.set(def.name, def);
    } catch (err) {
      console.warn(
        `[SkillRegistry] Skipping invalid skill file ${fullPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export class SkillRegistry implements ISkillRegistry {
  private _skills: Map<string, SkillDef> = new Map();
  private _projectDir: string | undefined;

  constructor(opts?: { projectDir?: string }) {
    this._projectDir = opts?.projectDir;
    this._load();
  }

  private _load(): void {
    const skills: Map<string, SkillDef> = new Map();
    loadSkillsFromDir(BUILTINS_DIR, 'builtin', skills);
    loadSkillsFromDir(USER_DIR, 'user', skills);
    if (this._projectDir !== undefined) {
      loadSkillsFromDir(join(this._projectDir, '.uplnk', 'skills'), 'project', skills);
    }
    this._skills = skills;
  }

  list(): SkillDef[] {
    return Array.from(this._skills.values());
  }

  get(name: string): SkillDef | undefined {
    return this._skills.get(name);
  }

  /**
   * Resolve agent-requested skill names to definitions.
   * Skips unknown names and `status: 'draft'` skills with a console.warn.
   * Order of return matches input order, after filtering.
   */
  resolve(names: readonly string[]): SkillDef[] {
    const out: SkillDef[] = [];
    for (const name of names) {
      const skill = this._skills.get(name);
      if (skill === undefined) {
        console.warn(`[SkillRegistry] Agent requested unknown skill: ${name}`);
        continue;
      }
      if (skill.status === 'draft') {
        console.warn(`[SkillRegistry] Skill ${name} is status:draft — not injecting`);
        continue;
      }
      out.push(skill);
    }
    return out;
  }

  async reload(projectDir?: string): Promise<void> {
    if (projectDir !== undefined) {
      this._projectDir = projectDir;
    }
    this._load();
  }
}

let _registry: SkillRegistry | undefined;

export function getSkillRegistry(opts?: { projectDir?: string }): SkillRegistry {
  if (_registry === undefined) {
    _registry = new SkillRegistry(opts);
  }
  return _registry;
}

export function __resetSkillRegistryForTests(): void {
  _registry = undefined;
}
