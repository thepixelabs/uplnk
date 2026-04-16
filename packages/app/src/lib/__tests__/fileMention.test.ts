/**
 * Tests for listMentionCandidates() and filterMentionCandidates().
 *
 * Uses real temp-dir fixtures (node:fs / node:os) so the filesystem walker
 * is exercised against actual directory entries — not mocked stat calls.
 * Each describe block resets the module cache via __resetMentionCacheForTests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  listMentionCandidates,
  filterMentionCandidates,
  __resetMentionCacheForTests,
} from '../fileMention.js';

// ─── Temp-dir fixture helpers ─────────────────────────────────────────────────

function createFile(root: string, relPath: string, content = ''): void {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf-8');
}

// ─── Suite setup ──────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'uplnk-mention-test-'));
  __resetMentionCacheForTests();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  __resetMentionCacheForTests();
});

// ─── listMentionCandidates ────────────────────────────────────────────────────

describe('listMentionCandidates — basic walk', () => {
  it('returns relative paths for files in the root directory', () => {
    createFile(tmpDir, 'index.ts');
    createFile(tmpDir, 'README.md');
    const results = listMentionCandidates(tmpDir);
    expect(results).toContain('index.ts');
    expect(results).toContain('README.md');
  });

  it('returns relative paths for nested files', () => {
    createFile(tmpDir, 'src/lib/utils.ts');
    const results = listMentionCandidates(tmpDir);
    expect(results).toContain('src/lib/utils.ts');
  });

  it('returns an empty array for a non-existent directory', () => {
    const results = listMentionCandidates('/does/not/exist/pylon-test');
    expect(results).toEqual([]);
  });

  it('returns an empty array for an empty directory', () => {
    const results = listMentionCandidates(tmpDir);
    expect(results).toEqual([]);
  });
});

describe('listMentionCandidates — skip directories', () => {
  it('skips node_modules directory and its contents', () => {
    createFile(tmpDir, 'node_modules/some-lib/index.js');
    createFile(tmpDir, 'src/app.ts');
    const results = listMentionCandidates(tmpDir);
    expect(results).not.toContain('node_modules/some-lib/index.js');
    expect(results).toContain('src/app.ts');
  });

  it('skips .git directory', () => {
    createFile(tmpDir, '.git/config');
    createFile(tmpDir, 'package.json', '{}');
    const results = listMentionCandidates(tmpDir);
    // .git is a dotdir — skip logic covers both dot-prefix and SKIP_DIRS
    expect(results.some((p) => p.startsWith('.git'))).toBe(false);
    expect(results).toContain('package.json');
  });

  it('skips dist directory', () => {
    createFile(tmpDir, 'dist/bundle.js');
    createFile(tmpDir, 'src/main.ts');
    const results = listMentionCandidates(tmpDir);
    expect(results.some((p) => p.startsWith('dist'))).toBe(false);
    expect(results).toContain('src/main.ts');
  });

  it('skips __pycache__ directory', () => {
    createFile(tmpDir, '__pycache__/module.cpython-311.pyc');
    createFile(tmpDir, 'main.py');
    const results = listMentionCandidates(tmpDir);
    expect(results.some((p) => p.startsWith('__pycache__'))).toBe(false);
  });
});

describe('listMentionCandidates — skip extensions', () => {
  it('skips .pyc files', () => {
    createFile(tmpDir, 'src/module.py');
    createFile(tmpDir, 'src/__pycache__'); // This is actually a dir — skip separately
    // Write a .pyc directly (bypassing __pycache__ skip)
    writeFileSync(join(tmpDir, 'src', 'module.pyc'), '', 'utf-8');
    const results = listMentionCandidates(tmpDir);
    expect(results).toContain('src/module.py');
    expect(results).not.toContain('src/module.pyc');
  });

  it('skips .map files', () => {
    createFile(tmpDir, 'dist'); // create as file, not dir, to bypass skip
    writeFileSync(join(tmpDir, 'app.js.map'), '', 'utf-8');
    createFile(tmpDir, 'app.js');
    const results = listMentionCandidates(tmpDir);
    expect(results).not.toContain('app.js.map');
    expect(results).toContain('app.js');
  });

  it('skips .min.js files', () => {
    writeFileSync(join(tmpDir, 'vendor.min.js'), '', 'utf-8');
    createFile(tmpDir, 'app.js');
    const results = listMentionCandidates(tmpDir);
    expect(results).not.toContain('vendor.min.js');
    expect(results).toContain('app.js');
  });
});

describe('listMentionCandidates — cache behaviour', () => {
  it('returns the same array reference on second call (cache hit)', () => {
    createFile(tmpDir, 'src/index.ts');
    const first = listMentionCandidates(tmpDir);
    const second = listMentionCandidates(tmpDir);
    // Same reference = cache was used
    expect(first).toBe(second);
  });

  it('performs a fresh walk when refresh: true is passed', () => {
    createFile(tmpDir, 'src/index.ts');
    const first = listMentionCandidates(tmpDir);

    // Add a new file after the first walk
    createFile(tmpDir, 'src/newfile.ts');
    const refreshed = listMentionCandidates(tmpDir, { refresh: true });

    expect(refreshed).not.toBe(first);
    expect(refreshed).toContain('src/newfile.ts');
  });

  it('__resetMentionCacheForTests clears the cache so next call re-walks', () => {
    createFile(tmpDir, 'src/alpha.ts');
    const first = listMentionCandidates(tmpDir);
    __resetMentionCacheForTests();

    createFile(tmpDir, 'src/beta.ts');
    const second = listMentionCandidates(tmpDir);

    expect(second).not.toBe(first);
    expect(second).toContain('src/beta.ts');
  });
});

// ─── filterMentionCandidates ──────────────────────────────────────────────────

describe('filterMentionCandidates — empty query', () => {
  it('returns all candidates (up to limit) when query is empty string', () => {
    const candidates = ['src/alpha.ts', 'src/beta.ts', 'README.md'];
    const results = filterMentionCandidates(candidates, '', 10);
    expect(results).toEqual(['src/alpha.ts', 'src/beta.ts', 'README.md']);
  });

  it('respects the limit for empty query', () => {
    const candidates = Array.from({ length: 30 }, (_, i) => `file${i.toString()}.ts`);
    const results = filterMentionCandidates(candidates, '', 5);
    expect(results).toHaveLength(5);
  });
});

describe('filterMentionCandidates — substring match', () => {
  it('includes only paths that contain the query substring', () => {
    const candidates = ['src/utils.ts', 'src/Button.tsx', 'README.md'];
    const results = filterMentionCandidates(candidates, 'utils', 20);
    expect(results).toEqual(['src/utils.ts']);
  });

  it('is case-insensitive', () => {
    const candidates = ['src/UserContext.tsx', 'src/userStore.ts', 'src/button.tsx'];
    const results = filterMentionCandidates(candidates, 'user', 20);
    expect(results).toContain('src/UserContext.tsx');
    expect(results).toContain('src/userStore.ts');
    expect(results).not.toContain('src/button.tsx');
  });

  it('returns empty array when no candidates match', () => {
    const candidates = ['src/alpha.ts', 'src/beta.ts'];
    const results = filterMentionCandidates(candidates, 'xyzzy', 20);
    expect(results).toEqual([]);
  });
});

describe('filterMentionCandidates — ranking by match position', () => {
  it('ranks a match at position 0 above a match at position 5', () => {
    // 'config.ts' matches 'config' at index 0
    // 'src/config.ts' matches 'config' at index 4
    const candidates = ['src/config.ts', 'config.ts'];
    const results = filterMentionCandidates(candidates, 'config', 20);
    expect(results[0]).toBe('config.ts');
    expect(results[1]).toBe('src/config.ts');
  });

  it('breaks ties alphabetically when match position is equal', () => {
    // Both 'src/alpha.ts' and 'src/beta.ts' match 'src' at index 0
    const candidates = ['src/beta.ts', 'src/alpha.ts'];
    const results = filterMentionCandidates(candidates, 'src', 20);
    expect(results[0]).toBe('src/alpha.ts');
    expect(results[1]).toBe('src/beta.ts');
  });

  it('respects the limit after sorting', () => {
    const candidates = [
      'utils/helpers.ts',
      'utils/format.ts',
      'utils/parse.ts',
      'src/utils.ts',
    ];
    const results = filterMentionCandidates(candidates, 'utils', 2);
    expect(results).toHaveLength(2);
    // 'src/utils.ts' matches 'utils' at index 4; the three 'utils/*' files match at 0
    // Top 2 should be from the 'utils/' prefix (position 0)
    expect(results[0]).toMatch(/^utils\//);
    expect(results[1]).toMatch(/^utils\//);
  });
});
