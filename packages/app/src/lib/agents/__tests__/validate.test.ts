/**
 * validate.ts — unit tests for parseAgentFile
 */

import { describe, it, expect, vi } from 'vitest';
import { parseAgentFile } from '../validate.js';

const MINIMAL_MD = `---
name: test-agent
description: A test agent for unit tests.
---

You are a helpful agent.
`;

const FULL_MD = `---
name: full-agent
description: Full-featured agent with all options.
model: qwen2.5-coder:7b
provider: ollama
temperature: 0.7
effort: high
tools:
  - WebSearch
  - Read
toolsDeny:
  - Bash
agents:
  - test-agent
maxDepth: 3
memory: project
color: "#FF5733"
icon: 🧪
userInvocable: true
maxTurns: 20
timeoutMs: 30000
---

You are a full-featured test agent.
`;

const INVALID_NAME_MD = `---
name: InvalidName
description: Agent with bad name.
---
`;

const MISSING_DESC_MD = `---
name: test-agent
---
`;

describe('parseAgentFile', () => {
  it('parses a minimal agent file with defaults', () => {
    const def = parseAgentFile(MINIMAL_MD, '/path/to/test.md', 'builtin');

    expect(def.name).toBe('test-agent');
    expect(def.description).toBe('A test agent for unit tests.');
    expect(def.systemPrompt).toBe('You are a helpful agent.');
    expect(def.model).toBe('inherit');
    expect(def.maxDepth).toBe(1);
    expect(def.maxTurns).toBe(10);
    expect(def.timeoutMs).toBe(600_000);
    expect(def.memory).toBe('none');
    expect(def.color).toBe('cyan');
    expect(def.icon).toBe('🤖');
    expect(def.userInvocable).toBe(true);
    expect(def.source).toBe('builtin');
    expect(def.sourcePath).toBe('/path/to/test.md');
  });

  it('parses a fully-specified agent file', () => {
    const def = parseAgentFile(FULL_MD, '/path/to/full.md', 'user');

    expect(def.name).toBe('full-agent');
    expect(def.model).toBe('qwen2.5-coder:7b');
    expect(def.provider).toBe('ollama');
    expect(def.temperature).toBe(0.7);
    expect(def.effort).toBe('high');
    expect(def.tools).toEqual(['WebSearch', 'Read']);
    expect(def.toolsDeny).toEqual(['Bash']);
    expect(def.agents).toEqual(['test-agent']);
    expect(def.maxDepth).toBe(3);
    // A.0.2: memory: 'project' is declared in the .md but coerced to 'none' at
    // parse time with a warning, because Phase C has not wired the scope yet.
    // The field is reserved in the schema for forward compatibility.
    expect(def.memory).toBe('none');
    expect(def.color).toBe('#FF5733');
    expect(def.icon).toBe('🧪');
    expect(def.maxTurns).toBe(20);
    expect(def.timeoutMs).toBe(30000);
    expect(def.source).toBe('user');
  });

  it('throws on invalid kebab-case name', () => {
    expect(() => parseAgentFile(INVALID_NAME_MD, '/path.md', 'builtin')).toThrow();
  });

  it('throws on missing description', () => {
    expect(() => parseAgentFile(MISSING_DESC_MD, '/path.md', 'builtin')).toThrow();
  });

  it('trims whitespace from systemPrompt', () => {
    const md = `---\nname: trim-agent\ndescription: Trim test.\n---\n\n\n  My prompt.  \n\n`;
    const def = parseAgentFile(md, '/path.md', 'project');
    expect(def.systemPrompt).toBe('My prompt.');
  });

  it('sets systemPrompt to empty string when body is blank', () => {
    const md = `---\nname: no-body\ndescription: No body.\n---\n`;
    const def = parseAgentFile(md, '/path.md', 'builtin');
    expect(def.systemPrompt).toBe('');
  });

  it('does not set optional fields when absent', () => {
    const def = parseAgentFile(MINIMAL_MD, '/path.md', 'builtin');
    expect('provider' in def).toBe(false);
    expect('temperature' in def).toBe(false);
    expect('tools' in def).toBe(false);
    expect('toolsDeny' in def).toBe(false);
    expect('agents' in def).toBe(false);
  });

  describe('A.0.2 memory scope coercion (Phase A foundation hardening)', () => {
    it('keeps memory: none as none with no warning', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const md = '---\nname: x\ndescription: x\nmemory: none\n---\nbody\n';
      const def = parseAgentFile(md, '/x.md', 'user');
      expect(def.memory).toBe('none');
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it.each(['project', 'user', 'local'] as const)(
      'coerces memory: %s to none and logs a warning',
      (scope) => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const md = `---\nname: x\ndescription: x\nmemory: ${scope}\n---\nbody\n`;
        const def = parseAgentFile(md, '/x.md', 'user');
        expect(def.memory).toBe('none');
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const warnMessage = warnSpy.mock.calls[0]![0] as string;
        expect(warnMessage).toContain(`'${scope}'`);
        expect(warnMessage).toContain('not yet implemented');
        warnSpy.mockRestore();
      },
    );

    it('rejects unknown memory scope values at parse time', () => {
      const md = '---\nname: x\ndescription: x\nmemory: nonsense\n---\nbody\n';
      expect(() => parseAgentFile(md, '/x.md', 'user')).toThrow();
    });
  });
});
