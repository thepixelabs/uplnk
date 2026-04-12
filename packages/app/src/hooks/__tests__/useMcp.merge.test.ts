/**
 * Unit tests for mergeMcpConfigs() — the pure merge function extracted from useMcp.
 *
 * No React, no filesystem, no McpManager. Just three arrays in, one merged
 * list + warnings out.
 */

import { describe, it, expect } from 'vitest';
import { mergeMcpConfigs } from '../useMcp.js';
import type { McpServerConfig } from '../../lib/mcp/McpManager.js';

// ─── Factory ──────────────────────────────────────────────────────────────────

function makeServer(id: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id,
    name: `Server ${id}`,
    type: 'http' as const,
    url: `http://${id}.local/mcp`,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('mergeMcpConfigs — empty inputs', () => {
  it('returns empty configs and no warnings when all three sources are empty', () => {
    const result = mergeMcpConfigs([], [], []);
    expect(result.configs).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe('mergeMcpConfigs — single source passthrough', () => {
  it('passes through a single config-only server', () => {
    const server = makeServer('alpha');
    const result = mergeMcpConfigs([server], [], []);
    expect(result.configs).toHaveLength(1);
    expect(result.configs[0]!.id).toBe('alpha');
    expect(result.warnings).toHaveLength(0);
  });

  it('passes through a single mcp.json server', () => {
    const server = makeServer('beta');
    const result = mergeMcpConfigs([], [server], []);
    expect(result.configs).toHaveLength(1);
    expect(result.configs[0]!.id).toBe('beta');
  });

  it('passes through a single plugin server', () => {
    const server = makeServer('gamma');
    const result = mergeMcpConfigs([], [], [server]);
    expect(result.configs).toHaveLength(1);
    expect(result.configs[0]!.id).toBe('gamma');
  });

  it('merges non-overlapping servers from all three sources', () => {
    const result = mergeMcpConfigs(
      [makeServer('from-config')],
      [makeServer('from-mcp-json')],
      [makeServer('from-plugin')],
    );
    expect(result.configs).toHaveLength(3);
    expect(result.warnings).toHaveLength(0);
    const ids = result.configs.map((c) => c.id);
    expect(ids).toContain('from-config');
    expect(ids).toContain('from-mcp-json');
    expect(ids).toContain('from-plugin');
  });
});

describe('mergeMcpConfigs — collision resolution (last write wins)', () => {
  it('mcp.json overrides config.json on id collision', () => {
    const fromConfig = makeServer('dispatch', { url: 'http://config.local/mcp' });
    const fromMcpJson = makeServer('dispatch', { url: 'http://project.local/mcp' });
    const result = mergeMcpConfigs([fromConfig], [fromMcpJson], []);
    expect(result.configs).toHaveLength(1);
    expect(result.configs[0]!.url).toBe('http://project.local/mcp');
  });

  it('project .mcp.json overrides both config.json and plugins on id collision', () => {
    // Precedence: config.json < plugins < .mcp.json — project-local wins.
    const fromConfig = makeServer('files', { url: 'http://config.local/mcp' });
    const fromMcpJson = makeServer('files', { url: 'http://project.local/mcp' });
    const fromPlugin = makeServer('files', { url: 'http://plugin.local/mcp' });
    const result = mergeMcpConfigs([fromConfig], [fromMcpJson], [fromPlugin]);
    expect(result.configs).toHaveLength(1);
    expect(result.configs[0]!.url).toBe('http://project.local/mcp');
  });

  it('emits a warning for each collision', () => {
    const result = mergeMcpConfigs(
      [makeServer('x')],
      [makeServer('x')],
      [makeServer('x')],
    );
    // Two collisions: config→mcp.json, mcp.json→plugin
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.every((w) => w.includes("'x'"))).toBe(true);
  });

  it('warning message identifies the overriding source label', () => {
    const result = mergeMcpConfigs([makeServer('svc')], [makeServer('svc')], []);
    const warning = result.warnings[0];
    expect(warning).toBeDefined();
    expect(warning).toContain('.mcp.json');
  });
});

describe('mergeMcpConfigs — builtin id rejection', () => {
  it('rejects a server with a __uplnk_builtin_ prefixed id', () => {
    const bad = makeServer('__uplnk_builtin_git');
    const result = mergeMcpConfigs([bad], [], []);
    expect(result.configs).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('__uplnk_builtin_git');
    expect(result.warnings[0]).toContain('reserved builtin id');
  });

  it('rejects builtin ids from all three sources', () => {
    const result = mergeMcpConfigs(
      [makeServer('__uplnk_builtin_files')],
      [makeServer('__uplnk_builtin_cmd')],
      [makeServer('__uplnk_builtin_rag')],
    );
    expect(result.configs).toHaveLength(0);
    expect(result.warnings).toHaveLength(3);
  });

  it('accepts legitimate servers while rejecting builtin ids in the same batch', () => {
    const result = mergeMcpConfigs(
      [makeServer('__uplnk_builtin_files'), makeServer('my-server')],
      [],
      [],
    );
    expect(result.configs).toHaveLength(1);
    expect(result.configs[0]!.id).toBe('my-server');
    expect(result.warnings).toHaveLength(1);
  });

  it('warning for builtin id names the source that supplied it', () => {
    const result = mergeMcpConfigs([], [], [makeServer('__uplnk_builtin_x')]);
    expect(result.warnings[0]).toContain('plugin');
  });
});
