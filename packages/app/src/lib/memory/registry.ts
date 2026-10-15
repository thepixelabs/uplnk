/**
 * MemoryRegistry — discovers, parses, and caches memory .md files.
 *
 * Discovery order (later overrides earlier by `name`):
 *   1. ~/.uplnk/memory/*.md                          (scope: 'user')
 *   2. <projectDir>/.uplnk/memory/*.md               (scope: 'project')
 *
 * No builtins — memories are user content, not shipped code.
 * Files that fail validation are skipped with console.warn — registry never throws.
 * Mirrors SkillRegistry exactly.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { parseMemoryFile } from './validate.js';
import type { MemoryDef, MemoryScope, IMemoryRegistry } from './types.js';

const USER_DIR = join(homedir(), '.uplnk', 'memory');

function loadMemoriesFromDir(dir: string, scope: MemoryScope, into: Map<string, MemoryDef>): void {
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
      const def = parseMemoryFile(raw, fullPath, scope);
      into.set(def.name, def);
    } catch (err) {
      console.warn(
        `[MemoryRegistry] Skipping invalid memory file ${fullPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export interface MemoryRegistryOpts {
  projectDir?: string;
  /** Override the user memory dir. Test-only. */
  userDir?: string;
}

export class MemoryRegistry implements IMemoryRegistry {
  private _memories: Map<string, MemoryDef> = new Map();
  private _projectDir: string | undefined;
  private _userDir: string;

  constructor(opts?: MemoryRegistryOpts) {
    this._projectDir = opts?.projectDir;
    this._userDir = opts?.userDir ?? USER_DIR;
    this._load();
  }

  private _load(): void {
    const memories: Map<string, MemoryDef> = new Map();
    loadMemoriesFromDir(this._userDir, 'user', memories);
    if (this._projectDir !== undefined) {
      loadMemoriesFromDir(join(this._projectDir, '.uplnk', 'memory'), 'project', memories);
    }
    this._memories = memories;
  }

  list(): MemoryDef[] {
    return Array.from(this._memories.values());
  }

  get(name: string): MemoryDef | undefined {
    return this._memories.get(name);
  }

  async reload(projectDir?: string): Promise<void> {
    if (projectDir !== undefined) {
      this._projectDir = projectDir;
    }
    this._load();
  }
}

let _registry: MemoryRegistry | undefined;

export function getMemoryRegistry(opts?: MemoryRegistryOpts): MemoryRegistry {
  if (_registry === undefined) {
    _registry = new MemoryRegistry(opts);
  }
  return _registry;
}

export function __resetMemoryRegistryForTests(): void {
  _registry = undefined;
}
