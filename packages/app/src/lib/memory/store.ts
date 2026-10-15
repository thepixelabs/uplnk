/**
 * MemoryStore — atomic mutations to memory .md files.
 *
 * Every write goes through the temp-file + rename pattern so a crash mid-write
 * never leaves a half-formed memory on disk. Names are derived from the first
 * six words of the description, collisions resolved via a 6-char ULID suffix.
 *
 * The store is intentionally tier-aware: callers say `scope: 'user' | 'project'`
 * and the store picks the correct directory. There is no implicit promotion
 * between tiers — the same operation that wrote a project memory is what
 * deletes or repins it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ulid } from 'ulid';
import { parseMemoryFile, serializeMemoryFile } from './validate.js';
import type { MemoryCategory, MemoryDef, MemoryScope, MemorySource } from './types.js';

const USER_DIR = join(homedir(), '.uplnk', 'memory');

export interface MemoryStoreOpts {
  projectDir?: string;
  /** Override the user memory dir. Test-only. */
  userDir?: string;
  /** Inject deterministic time for tests. */
  now?: () => Date;
}

export interface WriteMemoryInput {
  description: string;
  scope: MemoryScope;
  category?: MemoryCategory;
  pinned?: boolean;
  source?: MemorySource;
  body?: string;
}

const NAME_WORDS = 6;
const ULID_SUFFIX_LEN = 6;

export class MemoryStore {
  private _projectDir: string | undefined;
  private _userDir: string;
  private _now: () => Date;

  constructor(opts?: MemoryStoreOpts) {
    this._projectDir = opts?.projectDir;
    this._userDir = opts?.userDir ?? USER_DIR;
    this._now = opts?.now ?? (() => new Date());
  }

  /**
   * Persist a new memory. Returns the resulting MemoryDef. Throws only on
   * unrecoverable IO errors (parent dir cannot be created, rename fails) —
   * callers should surface these to the user, they indicate a broken disk
   * or permission problem.
   */
  write(input: WriteMemoryInput): MemoryDef {
    const description = input.description.trim();
    if (description.length === 0) throw new Error('MemoryStore.write: description is empty');
    if (description.length > 280) throw new Error('MemoryStore.write: description exceeds 280 chars');

    const category: MemoryCategory = input.category ?? 'fact';
    const source: MemorySource = input.source ?? 'user-edit';
    const pinned = input.pinned ?? category === 'identity';
    const createdAt = this._now().toISOString();
    const dir = this._dirFor(input.scope);
    mkdirSync(dir, { recursive: true });

    const name = this._allocateName(description, dir);
    const def: MemoryDef = {
      name,
      description,
      pinned,
      category,
      source,
      createdAt,
      sourcePath: join(dir, `${name}.md`),
      scope: input.scope,
    };
    if (input.body !== undefined && input.body.trim().length > 0) def.body = input.body.trim();

    this._atomicWrite(def.sourcePath, serializeMemoryFile(def));
    return def;
  }

  /** Remove a memory by name. Searches project first, then user. Idempotent. */
  delete(name: string): boolean {
    const path = this._findPath(name);
    if (path === null) return false;
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Set the pinned flag on an existing memory. Returns the updated def or null. */
  setPinned(name: string, pinned: boolean): MemoryDef | null {
    return this._mutate(name, (def) => ({ ...def, pinned }));
  }

  /** Refresh the `lastUsed` timestamp. Called after a memory is injected into a chat. */
  updateLastUsed(name: string): MemoryDef | null {
    const stamp = this._now().toISOString();
    return this._mutate(name, (def) => ({ ...def, lastUsed: stamp }));
  }

  private _mutate(name: string, fn: (def: MemoryDef) => MemoryDef): MemoryDef | null {
    const path = this._findPath(name);
    if (path === null) return null;
    let current: MemoryDef;
    try {
      const raw = readFileSync(path, 'utf8');
      const scope: MemoryScope = path.startsWith(this._userDir) ? 'user' : 'project';
      current = parseMemoryFile(raw, path, scope);
    } catch {
      return null;
    }
    const next = fn(current);
    this._atomicWrite(path, serializeMemoryFile(next));
    return next;
  }

  private _findPath(name: string): string | null {
    if (this._projectDir !== undefined) {
      const projectPath = join(this._projectDir, '.uplnk', 'memory', `${name}.md`);
      if (existsSync(projectPath)) return projectPath;
    }
    const userPath = join(this._userDir, `${name}.md`);
    if (existsSync(userPath)) return userPath;
    return null;
  }

  private _dirFor(scope: MemoryScope): string {
    if (scope === 'project') {
      if (this._projectDir === undefined) {
        throw new Error('MemoryStore.write: scope "project" requires a projectDir');
      }
      return join(this._projectDir, '.uplnk', 'memory');
    }
    return this._userDir;
  }

  /**
   * Derive a kebab-case name from the first NAME_WORDS words of the description.
   * If a file with that name already exists in `dir`, append a short ULID suffix.
   */
  private _allocateName(description: string, dir: string): string {
    const base = slugify(description, NAME_WORDS);
    const baseName = base.length > 0 ? base : 'memory';
    const initial = join(dir, `${baseName}.md`);
    if (!existsSync(initial)) return baseName;
    const suffix = ulid().slice(-ULID_SUFFIX_LEN).toLowerCase();
    return `${baseName}-${suffix}`;
  }

  private _atomicWrite(target: string, content: string): void {
    const tmp = `${target}.tmp.${ulid()}`;
    writeFileSync(tmp, content, { encoding: 'utf8' });
    renameSync(tmp, target);
  }
}

function slugify(text: string, maxWords: number): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return '';
  const words = cleaned.split(' ').slice(0, maxWords);
  const slug = words.join('-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  // Names must start with [a-z] per the validator regex; prepend `m-` if needed.
  if (slug.length === 0) return '';
  if (!/^[a-z]/.test(slug)) return `m-${slug}`;
  return slug;
}
