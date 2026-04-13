/**
 * Project context — indexes file names and structure into a system prompt.
 *
 * When the user launches with `uplnk --project /path/to/project`, this module:
 * 1. Walks the directory tree (respecting .gitignore patterns via heuristics)
 * 2. Builds a compact file tree string
 * 3. Returns a system prompt segment with the tree + cwd context
 *
 * The system prompt context is prepended to every conversation so the LLM
 * knows what files exist without reading them all.
 *
 * Design constraints:
 * - No external deps (no fast-glob, no ignore parser)
 * - Max 200 files in the tree to keep system prompt size reasonable
 * - Skip: node_modules, .git, dist, build, .next, __pycache__, *.pyc, etc.
 * - Works synchronously (called at startup, not during streaming)
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

// ─── Configuration ────────────────────────────────────────────────────────────

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
  'target',          // Rust / Java
  '.gradle',
  '.mvn',
]);

const SKIP_EXTENSIONS = new Set([
  '.pyc', '.pyo', '.class', '.jar', '.war', '.ear',
  '.o', '.a', '.so', '.dylib', '.dll', '.exe',
  '.lock',           // package-lock.json is indexed, but yarn.lock is noisy
  '.map',            // source maps
  '.min.js', '.min.css',
]);

const MAX_FILES = 200;
const MAX_DEPTH = 6;

// ─── Tree builder ─────────────────────────────────────────────────────────────

interface TreeEntry {
  path: string;
  isDir: boolean;
}

function walkDir(rootDir: string, maxFiles: number): TreeEntry[] {
  const entries: TreeEntry[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > MAX_DEPTH || entries.length >= maxFiles) return;

    let items: string[];
    try {
      items = readdirSync(dir).sort();
    } catch {
      return;
    }

    for (const item of items) {
      if (entries.length >= maxFiles) break;

      // Skip hidden items (dot-files) except a few useful ones
      if (item.startsWith('.') && item !== '.env.example' && item !== '.eslintrc') {
        continue;
      }

      const fullPath = join(dir, item);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(item)) continue;
        entries.push({ path: fullPath, isDir: true });
        walk(fullPath, depth + 1);
      } else {
        // Skip unwanted extensions
        const lc = item.toLowerCase();
        let skip = false;
        for (const ext of SKIP_EXTENSIONS) {
          if (lc.endsWith(ext)) { skip = true; break; }
        }
        if (!skip) {
          entries.push({ path: fullPath, isDir: false });
        }
      }
    }
  }

  walk(rootDir, 0);
  return entries;
}

function buildTreeString(rootDir: string, entries: TreeEntry[]): string {
  const lines: string[] = [rootDir + '/'];
  for (const entry of entries) {
    const rel = relative(rootDir, entry.path);
    const depth = rel.split('/').length - 1;
    const indent = '  '.repeat(depth);
    const name = rel.split('/').pop() ?? rel;
    lines.push(`${indent}${entry.isDir ? name + '/' : name}`);
  }
  return lines.join('\n');
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ProjectContext {
  rootDir: string;
  fileTree: string;
  fileCount: number;
  systemPrompt: string;
}

/**
 * Build project context from a directory path.
 * Returns null if the path doesn't exist or isn't a directory.
 */
export function buildProjectContext(projectDir: string): ProjectContext | null {
  if (!existsSync(projectDir)) return null;

  try {
    const stat = statSync(projectDir);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }

  const entries = walkDir(projectDir, MAX_FILES);
  const fileCount = entries.filter((e) => !e.isDir).length;
  const fileTree = buildTreeString(projectDir, entries);

  const truncationNote =
    entries.length >= MAX_FILES
      ? `\n(Showing first ${MAX_FILES} entries — run with a narrower --project path to see more.)`
      : '';

  const systemPrompt = [
    `You are working in the project at: ${projectDir}`,
    '',
    'Project file structure:',
    '```',
    fileTree + truncationNote,
    '```',
    '',
    'Use the mcp_file_read tool to read specific files as needed.',
    'Use the mcp_file_list tool to explore directories.',
  ].join('\n');

  return { rootDir: projectDir, fileTree, fileCount, systemPrompt };
}
