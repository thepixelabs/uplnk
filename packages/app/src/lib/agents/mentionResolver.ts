/**
 * MentionResolver — unified @ popover candidate source.
 *
 * Returns a merged, ranked list of MentionCandidate:
 *   1. Agents   (max 10, matched against name + description)
 *   2. Folders  (max 10, matched against path)
 *   3. Files    (max 20, matched against path)
 *
 * Total hard-capped at 30 results.
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { listMentionCandidates, filterMentionCandidates } from '../fileMention.js';
import type { MentionCandidate, IAgentRegistry } from './types.js';

const MAX_AGENTS = 10;
const MAX_FOLDERS = 10;
const MAX_FILES = 20;
const MAX_TOTAL = 30;

// ── Folder walking (mirrors fileMention walkFiles but returns dirs only) ──────

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', 'dist', 'build', '.next', '.nuxt',
  'out', '__pycache__', '.venv', 'venv', 'env', '.cache', '.parcel-cache',
  '.turbo', 'coverage', '.nyc_output', 'vendor', 'target', '.gradle', '.mvn',
]);

function walkFolders(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];
  const out: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];

  while (stack.length > 0 && out.length < 200) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (frame.depth > 6) continue;

    let items: string[];
    try { items = readdirSync(frame.dir).sort(); } catch { continue; }

    for (const item of items) {
      if (item.startsWith('.')) continue;
      const full = join(frame.dir, item);
      let isDir = false;
      try { isDir = statSync(full).isDirectory(); } catch { continue; }
      if (!isDir) continue;
      if (SKIP_DIRS.has(item)) continue;
      out.push(relative(rootDir, full) + '/');
      stack.push({ dir: full, depth: frame.depth + 1 });
    }
  }
  return out;
}

// ── Agent matching ─────────────────────────────────────────────────────────────

function matchAgents(
  registry: IAgentRegistry,
  query: string,
): MentionCandidate[] {
  const q = query.toLowerCase();
  const all = registry.list().filter((a) => a.userInvocable);

  if (q === '') {
    return all.slice(0, MAX_AGENTS).map((a) => ({
      kind: 'agent' as const,
      insertText: a.name,
      name: a.name,
      description: a.description.split('\n')[0] ?? a.description,
      icon: a.icon,
      color: a.color,
      source: a.source,
    }));
  }

  const scored: Array<{ def: typeof all[number]; score: number }> = [];
  for (const a of all) {
    const combined = `${a.name} ${a.description}`.toLowerCase();
    const idx = combined.indexOf(q);
    if (idx >= 0) scored.push({ def: a, score: idx });
  }
  scored.sort((a, b) => a.score - b.score);

  return scored.slice(0, MAX_AGENTS).map(({ def: a }) => ({
    kind: 'agent' as const,
    insertText: a.name,
    name: a.name,
    description: a.description.split('\n')[0] ?? a.description,
    icon: a.icon,
    color: a.color,
    source: a.source,
  }));
}

// ── Folder matching ────────────────────────────────────────────────────────────

const folderCache = new Map<string, string[]>();

function matchFolders(projectDir: string, query: string): MentionCandidate[] {
  let dirs = folderCache.get(projectDir);
  if (dirs === undefined) {
    dirs = walkFolders(projectDir);
    folderCache.set(projectDir, dirs);
  }

  const q = query.toLowerCase();
  const filtered = q === ''
    ? dirs.slice(0, MAX_FOLDERS)
    : dirs.filter((d) => d.toLowerCase().includes(q)).slice(0, MAX_FOLDERS);

  return filtered.map((path) => ({
    kind: 'folder' as const,
    insertText: path,
    path,
  }));
}

// ── Public API ─────────────────────────────────────────────────────────────────

export class MentionResolver {
  constructor(private readonly registry: IAgentRegistry) {}

  resolve(query: string, projectDir: string | undefined): MentionCandidate[] {
    const results: MentionCandidate[] = [];

    // 1. Agents
    results.push(...matchAgents(this.registry, query));

    // 2. Folders
    if (projectDir !== undefined) {
      results.push(...matchFolders(projectDir, query));
    }

    // 3. Files
    if (projectDir !== undefined) {
      const rawFiles = listMentionCandidates(projectDir);
      const filtered = filterMentionCandidates(rawFiles, query, MAX_FILES);
      for (const path of filtered) {
        results.push({ kind: 'file', insertText: path, path });
      }
    }

    return results.slice(0, MAX_TOTAL);
  }
}
