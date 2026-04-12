/**
 * File mention helper — supplies the list of relative paths used by the
 * `@file` autocomplete popover in ChatInput.
 *
 * Uses a simple synchronous walker mirroring projectContext's `walkDir` but
 * returns file-only relative paths (not directories). Results are cached in
 * module scope per `rootDir` so the first `@` keystroke is the only time we
 * touch the filesystem — subsequent mentions in the same session reuse the
 * snapshot.
 *
 * Cap is 1000 entries: large enough to be useful in medium monorepos,
 * small enough to filter-on-keystroke without lag. Projects exceeding the
 * cap silently truncate to the first 1000 entries.
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'out',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.cache',
  '.parcel-cache',
  '.turbo',
  'coverage',
  '.nyc_output',
  'vendor',
  'target',
  '.gradle',
  '.mvn',
]);

const SKIP_EXTENSIONS = new Set([
  '.pyc', '.pyo', '.class', '.jar', '.war', '.ear',
  '.o', '.a', '.so', '.dylib', '.dll', '.exe',
  '.lock',
  '.map',
  '.min.js', '.min.css',
]);

const MAX_ENTRIES = 1000;
const MAX_DEPTH = 8;

const cache = new Map<string, string[]>();

function walkFiles(rootDir: string): string[] {
  const out: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];

  while (stack.length > 0 && out.length < MAX_ENTRIES) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (frame.depth > MAX_DEPTH) continue;

    let items: string[];
    try {
      items = readdirSync(frame.dir).sort();
    } catch {
      continue;
    }

    for (const item of items) {
      if (out.length >= MAX_ENTRIES) break;
      if (item.startsWith('.') && item !== '.env.example') continue;

      const full = join(frame.dir, item);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(item)) continue;
        stack.push({ dir: full, depth: frame.depth + 1 });
        continue;
      }

      const lower = item.toLowerCase();
      let skip = false;
      for (const ext of SKIP_EXTENSIONS) {
        if (lower.endsWith(ext)) { skip = true; break; }
      }
      if (skip) continue;

      out.push(relative(rootDir, full));
    }
  }

  return out;
}

/**
 * Return the list of candidate relative paths for `@file` completion.
 *
 * Cached per `rootDir` for the process lifetime. Pass `refresh: true` to
 * force a fresh walk (e.g. after the user creates new files and expects
 * autocomplete to see them).
 */
export function listMentionCandidates(
  rootDir: string,
  options?: { refresh?: boolean },
): string[] {
  if (!existsSync(rootDir)) return [];
  if (options?.refresh !== true && cache.has(rootDir)) {
    return cache.get(rootDir) ?? [];
  }
  const entries = walkFiles(rootDir);
  cache.set(rootDir, entries);
  return entries;
}

/**
 * Fuzzy-filter the candidate list against a query. Case-insensitive
 * substring match; results are ranked by the position of the first match
 * (earlier = better), then alphabetically. Caller passes `limit` to cap the
 * number of candidates returned to the popover.
 */
export function filterMentionCandidates(
  candidates: string[],
  query: string,
  limit = 20,
): string[] {
  if (query === '') return candidates.slice(0, limit);
  const q = query.toLowerCase();

  const scored: Array<{ path: string; score: number }> = [];
  for (const path of candidates) {
    const idx = path.toLowerCase().indexOf(q);
    if (idx >= 0) scored.push({ path, score: idx });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.path.localeCompare(b.path);
  });
  return scored.slice(0, limit).map((r) => r.path);
}

/** Test-only: drop the cache so tests observe filesystem changes. */
export function __resetMentionCacheForTests(): void {
  cache.clear();
}
