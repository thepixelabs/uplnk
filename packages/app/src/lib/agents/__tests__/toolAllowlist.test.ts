/**
 * toolAllowlist — tests for the agent tool-allowlist resolution:
 *
 *   1. resolveToolAllowlist(): exact names, Claude-Code-style compatibility
 *      aliases (user/project defs only), unknown-name warnings.
 *   2. Every builtin agent def validates AND resolves to a non-empty toolset
 *      against a stub of uplnk's REAL root tool names — this is the
 *      regression test for the bug where Claude-Code-style names silently
 *      intersected to zero tools.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveToolAllowlist, TOOL_NAME_ALIASES } from '../orchestrator.js';
import { parseAgentFile } from '../validate.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolRecord = Record<string, any>;

/** Stub of uplnk's real root toolset (names from lib/mcp/servers/*). */
function makeRootToolsetStub(): AnyToolRecord {
  const names = [
    'mcp_file_read',
    'mcp_file_list',
    'mcp_file_write',
    'mcp_file_patch',
    'mcp_command_exec',
    'mcp_git_status',
    'mcp_git_diff',
    'mcp_git_stage',
    'mcp_git_commit',
    'mcp_rag_search',
    'mcp_rag_index',
  ];
  const tools: AnyToolRecord = {};
  for (const n of names) tools[n] = { description: `stub ${n}` };
  return tools;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveToolAllowlist', () => {
  it('grants exact-name matches verbatim', () => {
    const base = makeRootToolsetStub();
    const resolved = resolveToolAllowlist(['mcp_file_read', 'mcp_rag_search'], base, {
      agentName: 'exact-1',
      source: 'builtin',
    });
    expect(Object.keys(resolved).sort()).toEqual(['mcp_file_read', 'mcp_rag_search']);
  });

  it('resolves Claude-Code-style aliases for user-authored defs, under the REAL name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = makeRootToolsetStub();
    const resolved = resolveToolAllowlist(
      ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
      base,
      { agentName: 'alias-1', source: 'user' },
    );
    expect(Object.keys(resolved).sort()).toEqual([
      'mcp_command_exec',
      'mcp_file_list',
      'mcp_file_patch',
      'mcp_file_read',
      'mcp_file_write',
      'mcp_rag_search',
    ]);
    // Warning names the alias used
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("'Read'") && m.includes('mcp_file_read'))).toBe(true);
    expect(messages.some((m) => m.includes("'Bash'") && m.includes('mcp_command_exec'))).toBe(true);
  });

  it('resolves aliases for project-authored defs too', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = makeRootToolsetStub();
    const resolved = resolveToolAllowlist(['Read'], base, {
      agentName: 'alias-2',
      source: 'project',
    });
    expect(Object.keys(resolved)).toEqual(['mcp_file_read']);
  });

  it('does NOT apply aliases to builtin-sourced defs (builtins ship real names)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = makeRootToolsetStub();
    const resolved = resolveToolAllowlist(['Read'], base, {
      agentName: 'alias-3',
      source: 'builtin',
    });
    expect(Object.keys(resolved)).toEqual([]);
  });

  it('prefers an exact match over an alias', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base: AnyToolRecord = {
      Read: { description: 'a literal tool actually named Read' },
      mcp_file_read: { description: 'real read' },
    };
    const resolved = resolveToolAllowlist(['Read'], base, {
      agentName: 'exact-over-alias',
      source: 'user',
    });
    expect(Object.keys(resolved)).toEqual(['Read']);
  });

  it('drops unknown names (existing behaviour) but warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = makeRootToolsetStub();
    const resolved = resolveToolAllowlist(['NoSuchTool', 'mcp_file_read'], base, {
      agentName: 'unknown-1',
      source: 'user',
    });
    expect(Object.keys(resolved)).toEqual(['mcp_file_read']);
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("'NoSuchTool'") && m.includes('not granted'))).toBe(true);
  });

  it('warns only once per agent+name (process-lifetime dedup)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = makeRootToolsetStub();
    resolveToolAllowlist(['Read'], base, { agentName: 'warn-once', source: 'user' });
    resolveToolAllowlist(['Read'], base, { agentName: 'warn-once', source: 'user' });
    const aliasWarnings = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('@warn-once') && m.includes("'Read'"));
    expect(aliasWarnings).toHaveLength(1);
  });

  it('covers every documented alias target with a real root tool name', () => {
    const base = makeRootToolsetStub();
    for (const target of Object.values(TOOL_NAME_ALIASES)) {
      expect(base[target]).toBeDefined();
    }
  });
});

describe('builtin agent defs', () => {
  const builtinsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'builtins');
  const files = readdirSync(builtinsDir).filter((f) => extname(f) === '.md');

  it('finds the expected builtin definition files', () => {
    const names = files.map((f) => f.replace(/\.md$/, '')).sort();
    expect(names).toEqual(
      expect.arrayContaining(['coder', 'planner', 'researcher', 'reviewer', 'summarizer', 'tester']),
    );
  });

  it('every builtin def parses (validates) successfully', () => {
    for (const file of files) {
      const raw = readFileSync(join(builtinsDir, file), 'utf8');
      expect(() => parseAgentFile(raw, join(builtinsDir, file), 'builtin')).not.toThrow();
    }
  });

  it('every builtin allowlist entry names a REAL root tool (no aliases needed)', () => {
    const base = makeRootToolsetStub();
    for (const file of files) {
      const raw = readFileSync(join(builtinsDir, file), 'utf8');
      const def = parseAgentFile(raw, join(builtinsDir, file), 'builtin');
      for (const name of def.tools ?? []) {
        expect(base[name], `${file}: tool '${name}' is not a real root tool`).toBeDefined();
      }
    }
  });

  it('every builtin with a non-empty allowlist resolves to a NON-EMPTY toolset', () => {
    const base = makeRootToolsetStub();
    for (const file of files) {
      const raw = readFileSync(join(builtinsDir, file), 'utf8');
      const def = parseAgentFile(raw, join(builtinsDir, file), 'builtin');
      if (def.tools === undefined || def.tools.length === 0) continue; // inherit-all / explicit no-tools
      const resolved = resolveToolAllowlist(def.tools, base, {
        agentName: def.name,
        source: 'builtin',
      });
      expect(
        Object.keys(resolved).length,
        `${file}: allowlist [${def.tools.join(', ')}] resolved to zero tools`,
      ).toBeGreaterThan(0);
      // The whole allowlist resolves — nothing is silently dropped.
      expect(Object.keys(resolved)).toHaveLength(def.tools.length);
    }
  });

  it('summarizer deliberately has an empty allowlist (persona: no tool access)', () => {
    const raw = readFileSync(join(builtinsDir, 'summarizer.md'), 'utf8');
    const def = parseAgentFile(raw, join(builtinsDir, 'summarizer.md'), 'builtin');
    expect(def.tools).toEqual([]);
  });
});
