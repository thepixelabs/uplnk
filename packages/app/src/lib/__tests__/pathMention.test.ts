import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commonPrefix,
  detectPathContext,
  formatPathContextHeader,
  listPathEntries,
} from '../pathMention.js';

describe('detectPathContext', () => {
  const projectDir = '/proj';

  it('returns null for plain identifier', () => {
    expect(detectPathContext('coder', projectDir)).toBeNull();
    expect(detectPathContext('my-agent', projectDir)).toBeNull();
    expect(detectPathContext('', projectDir)).toBeNull();
  });

  it('detects relative ./', () => {
    const ctx = detectPathContext('./src/foo', projectDir);
    expect(ctx).not.toBeNull();
    expect(ctx!.mode).toBe('relative');
    expect(ctx!.baseDir).toBe(projectDir);
    expect(ctx!.segments).toEqual(['.', 'src']);
    expect(ctx!.currentSegment).toBe('foo');
  });

  it('detects relative ../', () => {
    const ctx = detectPathContext('../x/y', projectDir);
    expect(ctx!.mode).toBe('relative');
    expect(ctx!.segments).toEqual(['..', 'x']);
    expect(ctx!.currentSegment).toBe('y');
  });

  it('detects absolute /abs', () => {
    const ctx = detectPathContext('/etc/hosts', projectDir);
    expect(ctx!.mode).toBe('absolute');
    expect(ctx!.baseDir).toBe('/');
    expect(ctx!.segments).toEqual(['etc']);
    expect(ctx!.currentSegment).toBe('hosts');
  });

  it('detects home ~/', () => {
    const ctx = detectPathContext('~/Documents/', projectDir);
    expect(ctx!.mode).toBe('home');
    expect(ctx!.baseDir).toBe(homedir());
    expect(ctx!.segments).toEqual(['Documents']);
    expect(ctx!.currentSegment).toBe('');
  });

  it('switches to path mode when query has a / even without leading ./', () => {
    const ctx = detectPathContext('src/hooks', projectDir);
    expect(ctx!.mode).toBe('relative');
    expect(ctx!.segments).toEqual(['src']);
    expect(ctx!.currentSegment).toBe('hooks');
  });

  it('handles bare `.` or `..`', () => {
    expect(detectPathContext('.', projectDir)!.currentSegment).toBe('.');
    expect(detectPathContext('..', projectDir)!.currentSegment).toBe('..');
  });

  it('handles trailing slash — currentSegment is empty', () => {
    const ctx = detectPathContext('./src/', projectDir);
    expect(ctx!.segments).toEqual(['.', 'src']);
    expect(ctx!.currentSegment).toBe('');
  });
});

describe('listPathEntries', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'uplnk-path-'));
    mkdirSync(join(tmp, 'src'));
    mkdirSync(join(tmp, 'src/hooks'));
    mkdirSync(join(tmp, 'node_modules'));
    writeFileSync(join(tmp, 'README.md'), '#');
    writeFileSync(join(tmp, 'src/index.ts'), '');
    writeFileSync(join(tmp, 'src/server.ts'), '');
    writeFileSync(join(tmp, 'src/hooks/useA.ts'), '');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('lists top-level entries with empty currentSegment', () => {
    const ctx = detectPathContext('./', tmp)!;
    const out = listPathEntries(ctx);
    // dirs first alphabetically, then files; node_modules filtered
    const names = out.map((e) => e.name);
    expect(names).toContain('src');
    expect(names).toContain('README.md');
    expect(names).not.toContain('node_modules');
    const srcIdx = names.indexOf('src');
    const readmeIdx = names.indexOf('README.md');
    expect(srcIdx).toBeLessThan(readmeIdx); // dir before file
  });

  it('filters by prefix', () => {
    const ctx = detectPathContext('./src/i', tmp)!;
    const out = listPathEntries(ctx);
    expect(out.map((e) => e.name)).toEqual(['index.ts']);
  });

  it('dirs carry trailing slash in insertFragment', () => {
    const ctx = detectPathContext('./', tmp)!;
    const out = listPathEntries(ctx);
    const src = out.find((e) => e.name === 'src')!;
    expect(src.insertFragment).toBe('src/');
  });

  it('returns empty list for nonexistent listing dir', () => {
    const ctx = detectPathContext('./nope/', tmp)!;
    expect(listPathEntries(ctx)).toEqual([]);
  });

  it('walks into subdir via segments', () => {
    const ctx = detectPathContext('./src/ho', tmp)!;
    expect(listPathEntries(ctx).map((e) => e.name)).toEqual(['hooks']);
  });
});

describe('commonPrefix', () => {
  it('returns empty for empty list', () => {
    expect(commonPrefix([])).toBe('');
  });

  it('returns full name for single entry', () => {
    expect(
      commonPrefix([{ name: 'useStream.ts', isDir: false, insertFragment: 'useStream.ts' }]),
    ).toBe('useStream.ts');
  });

  it('returns shared prefix across entries', () => {
    expect(
      commonPrefix([
        { name: 'useStream.ts', isDir: false, insertFragment: 'useStream.ts' },
        { name: 'useState.ts',  isDir: false, insertFragment: 'useState.ts' },
      ]),
    ).toBe('useSt');
  });

  it('returns empty when nothing shared', () => {
    expect(
      commonPrefix([
        { name: 'alpha.ts', isDir: false, insertFragment: 'alpha.ts' },
        { name: 'beta.ts',  isDir: false, insertFragment: 'beta.ts' },
      ]),
    ).toBe('');
  });
});

describe('formatPathContextHeader', () => {
  it('renders relative', () => {
    expect(
      formatPathContextHeader({
        mode: 'relative',
        baseDir: '/x',
        segments: ['.', 'src'],
        currentSegment: '',
      }),
    ).toBe('./src/');
  });

  it('renders home with no segments', () => {
    expect(
      formatPathContextHeader({
        mode: 'home',
        baseDir: homedir(),
        segments: [],
        currentSegment: 'D',
      }),
    ).toBe('~/');
  });

  it('renders absolute', () => {
    expect(
      formatPathContextHeader({
        mode: 'absolute',
        baseDir: '/',
        segments: ['etc'],
        currentSegment: 'h',
      }),
    ).toBe('/etc/');
  });
});
