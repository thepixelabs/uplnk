import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildProjectContext } from '../projectContext.js';

describe('buildProjectContext', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'uplnk-proj-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for non-existent directory', () => {
    const result = buildProjectContext('/does/not/exist/at/all');
    expect(result).toBeNull();
  });

  it('returns a valid context for an existing directory', () => {
    writeFileSync(join(tmpDir, 'README.md'), '# Test', 'utf-8');
    const result = buildProjectContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result?.rootDir).toBe(tmpDir);
    expect(result?.systemPrompt).toContain('README.md');
  });

  it('includes system prompt with project dir path', () => {
    const result = buildProjectContext(tmpDir);
    expect(result?.systemPrompt).toContain(tmpDir);
    expect(result?.systemPrompt).toContain('mcp_file_read');
  });

  it('skips node_modules directory', () => {
    mkdirSync(join(tmpDir, 'node_modules', 'some-pkg'), { recursive: true });
    writeFileSync(join(tmpDir, 'node_modules', 'some-pkg', 'index.js'), '', 'utf-8');
    const result = buildProjectContext(tmpDir);
    expect(result?.fileTree).not.toContain('node_modules');
  });

  it('skips .git directory', () => {
    mkdirSync(join(tmpDir, '.git'), { recursive: true });
    writeFileSync(join(tmpDir, '.git', 'config'), '[core]', 'utf-8');
    const result = buildProjectContext(tmpDir);
    expect(result?.fileTree).not.toContain('.git');
  });

  it('skips hidden files', () => {
    writeFileSync(join(tmpDir, '.env'), 'SECRET=123', 'utf-8');
    const result = buildProjectContext(tmpDir);
    // .env is hidden — should not appear in tree
    expect(result?.fileTree).not.toContain('.env');
  });

  it('includes visible source files', () => {
    writeFileSync(join(tmpDir, 'index.ts'), 'export {}', 'utf-8');
    writeFileSync(join(tmpDir, 'package.json'), '{}', 'utf-8');
    const result = buildProjectContext(tmpDir);
    expect(result?.fileTree).toContain('index.ts');
    expect(result?.fileTree).toContain('package.json');
  });

  it('counts files correctly', () => {
    writeFileSync(join(tmpDir, 'a.ts'), '', 'utf-8');
    writeFileSync(join(tmpDir, 'b.ts'), '', 'utf-8');
    const result = buildProjectContext(tmpDir);
    expect(result?.fileCount).toBe(2);
  });

  it('handles empty directory', () => {
    const result = buildProjectContext(tmpDir);
    // Empty dir is valid — just has no files
    expect(result).not.toBeNull();
    expect(result?.fileCount).toBe(0);
  });
});
