/**
 * pathMention — hierarchical `@` path autocomplete.
 *
 * Complements the existing flat fuzzy `MentionResolver` (agent/folder/file
 * popover) by driving segment-by-segment directory traversal when the user's
 * in-progress @token starts with a path shape (`./`, `../`, `~/`, `/abs`).
 *
 * Pure fs I/O — no MCP, no allowlist. Use from inside ChatInput's mention
 * state machine: detectPathContext() decides which mode to be in,
 * listPathEntries() drives the visible popover, commonPrefix() powers Tab.
 */

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export type PathMode = 'relative' | 'home' | 'absolute';

export interface PathContext {
  mode: PathMode;
  /** Absolute resolved base directory the listing walks from. */
  baseDir: string;
  /**
   * Path segments (between slashes) already committed. E.g. for `@../src/`
   * with mode 'relative' and baseDir=projectDir, segments=['..', 'src'].
   * Preserves '..' and '.' verbatim so subsequent resolve() works correctly.
   */
  segments: string[];
  /** Partially-typed last segment (the filter prefix). May be empty. */
  currentSegment: string;
}

export interface PathEntry {
  name: string;
  isDir: boolean;
  /** Text to insert when this entry is chosen; dirs get trailing '/'. */
  insertFragment: string;
}

const SKIP_ENTRIES = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  '.venv',
  '.turbo',
  '.nuxt',
  '.svelte-kit',
  '__pycache__',
]);

const MAX_ENTRIES_PER_LISTING = 300;

/**
 * Decide whether a mention query is a path form and return the parsed context.
 * Returns null for plain identifiers (which stay in the mixed-mode popover).
 *
 * Rules, in order:
 *   1. `~/…`           → home
 *   2. `/abs/…`        → absolute (baseDir=/)
 *   3. `./…` or `../…` or contains '/' → relative to projectDir
 *   4. otherwise → null
 */
export function detectPathContext(
  query: string,
  projectDir: string,
): PathContext | null {
  if (query.length === 0) return null;

  let mode: PathMode;
  let baseDir: string;
  let rest: string;

  if (query === '~' || query.startsWith('~/')) {
    mode = 'home';
    baseDir = homedir();
    rest = query === '~' ? '' : query.slice(2);
  } else if (query.startsWith('/')) {
    mode = 'absolute';
    baseDir = '/';
    rest = query.slice(1);
  } else if (
    query.startsWith('./') ||
    query.startsWith('../') ||
    query === '.' ||
    query === '..' ||
    query.includes('/')
  ) {
    mode = 'relative';
    baseDir = projectDir;
    rest = query;
  } else {
    return null;
  }

  const parts = rest.split('/');
  const currentSegment = parts[parts.length - 1] ?? '';
  const segments = parts.slice(0, -1);
  return { mode, baseDir, segments, currentSegment };
}

/**
 * List entries under the context's listing directory, filtered by the current
 * (in-progress) segment as a case-sensitive prefix. Dirs come first, both
 * groups sorted alphabetically. Caps at MAX_ENTRIES_PER_LISTING.
 * Returns an empty array on any fs error (no throw).
 */
export function listPathEntries(ctx: PathContext): PathEntry[] {
  const listingDir = resolve(ctx.baseDir, ...ctx.segments);
  let names: string[];
  try {
    names = readdirSync(listingDir);
  } catch {
    return [];
  }

  const prefix = ctx.currentSegment;
  const dirs: PathEntry[] = [];
  const files: PathEntry[] = [];

  for (const name of names) {
    if (dirs.length + files.length >= MAX_ENTRIES_PER_LISTING) break;
    if (SKIP_ENTRIES.has(name)) continue;
    if (prefix !== '' && !name.startsWith(prefix)) continue;
    let isDir = false;
    try {
      isDir = statSync(resolve(listingDir, name)).isDirectory();
    } catch {
      continue;
    }
    const entry: PathEntry = {
      name,
      isDir,
      insertFragment: isDir ? `${name}/` : name,
    };
    (isDir ? dirs : files).push(entry);
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files];
}

/**
 * Longest common prefix of the entries' names. Used by Tab to extend the
 * user's in-progress segment as far as the entries agree. Returns '' when
 * the list is empty.
 */
export function commonPrefix(entries: readonly PathEntry[]): string {
  if (entries.length === 0) return '';
  let prefix = entries[0]!.name;
  for (let i = 1; i < entries.length; i++) {
    const name = entries[i]!.name;
    let j = 0;
    const max = Math.min(prefix.length, name.length);
    while (j < max && prefix[j] === name[j]) j++;
    prefix = prefix.slice(0, j);
    if (prefix === '') break;
  }
  return prefix;
}

/**
 * Build the display label for the popover header so the user sees exactly
 * which directory is being listed. Purely cosmetic.
 */
export function formatPathContextHeader(ctx: PathContext): string {
  const prefix =
    ctx.mode === 'home' ? '~/' : ctx.mode === 'absolute' ? '/' : '';
  const joined = ctx.segments.length > 0 ? `${ctx.segments.join('/')}/` : '';
  return `${prefix}${joined}`;
}
