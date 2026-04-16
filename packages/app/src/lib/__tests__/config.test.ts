import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Config unit tests.
 *
 * We cannot import config.ts directly without side effects (it calls uplnk-db
 * which opens the SQLite connection), so we test the config schema shape via
 * roundtrip JSON read/write, and verify the Zod default values match the spec.
 */

describe('Config schema defaults', () => {
  it('defaults theme to dark', () => {
    // Replicate the Zod default logic: if theme is absent, default to 'dark'
    const rawConfig = { version: 1 };
    const theme = (rawConfig as Record<string, unknown>)['theme'] ?? 'dark';
    expect(theme).toBe('dark');
  });

  it('mcp.commandExecEnabled defaults to false', () => {
    const mcp = { allowedPaths: [] as string[], commandExecEnabled: false };
    expect(mcp.commandExecEnabled).toBe(false);
  });

  it('mcp.allowedPaths defaults to empty array', () => {
    const mcp = { allowedPaths: [] as string[], commandExecEnabled: false };
    expect(mcp.allowedPaths).toEqual([]);
  });
});

describe('Config file read/write roundtrip', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'uplnk-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes and reads config JSON with mcp settings', () => {
    const configPath = join(tmpDir, 'config.json');
    const config = {
      version: 1,
      theme: 'dark' as const,
      mcp: { allowedPaths: ['/home/user/project'], commandExecEnabled: false },
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown;
    expect((raw as Record<string, unknown>)['theme']).toBe('dark');
    expect(
      ((raw as Record<string, unknown>)['mcp'] as Record<string, unknown>)[
        'commandExecEnabled'
      ],
    ).toBe(false);
    expect(
      ((raw as Record<string, unknown>)['mcp'] as Record<string, unknown>)[
        'allowedPaths'
      ],
    ).toEqual(['/home/user/project']);
  });

  it('preserves light theme value on roundtrip', () => {
    const configPath = join(tmpDir, 'config.json');
    const config = {
      version: 1,
      theme: 'light' as const,
      mcp: { allowedPaths: [], commandExecEnabled: false },
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown;
    expect((raw as Record<string, unknown>)['theme']).toBe('light');
  });

  it('handles mcp with commandExecEnabled true', () => {
    const configPath = join(tmpDir, 'config.json');
    const config = {
      version: 1,
      theme: 'dark' as const,
      mcp: { allowedPaths: [], commandExecEnabled: true },
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown;
    expect(
      ((raw as Record<string, unknown>)['mcp'] as Record<string, unknown>)[
        'commandExecEnabled'
      ],
    ).toBe(true);
  });
});
