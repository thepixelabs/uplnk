/**
 * parseUserInput.ts — unit tests for parseAgentMention and extractMentions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractMentions,
  formatAttachmentsForContext,
  parseAgentMention,
} from '../parseUserInput.js';
import type { IAgentRegistry, AgentDef } from '../types.js';

function makeAgent(name: string): AgentDef {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: '',
    model: 'inherit',
    maxDepth: 1,
    memory: 'none',
    color: 'cyan',
    icon: '🤖',
    userInvocable: true,
    maxTurns: 10,
    timeoutMs: 600_000,
    source: 'builtin',
    sourcePath: `/path/${name}.md`,
  };
}

function makeRegistry(names: string[]): IAgentRegistry {
  const agents = new Map(names.map((n) => [n, makeAgent(n)]));
  return {
    list: () => Array.from(agents.values()),
    get: (name: string) => agents.get(name),
    reload: async () => {},
  };
}

describe('parseAgentMention', () => {
  const registry = makeRegistry(['researcher', 'summarizer', 'my-agent']);

  it('returns null for plain message', () => {
    expect(parseAgentMention('hello world', registry)).toBeNull();
  });

  it('returns null when no space after @name', () => {
    expect(parseAgentMention('@researcher', registry)).toBeNull();
  });

  it('returns null when agent is not in registry', () => {
    expect(parseAgentMention('@unknown do something', registry)).toBeNull();
  });

  it('parses a valid @mention', () => {
    const result = parseAgentMention('@researcher find the answer', registry);
    expect(result).not.toBeNull();
    expect(result!.agent.name).toBe('researcher');
    expect(result!.prompt).toBe('find the answer');
  });

  it('parses hyphenated agent name', () => {
    const result = parseAgentMention('@my-agent do a thing', registry);
    expect(result).not.toBeNull();
    expect(result!.agent.name).toBe('my-agent');
  });

  it('preserves multiline prompt', () => {
    const result = parseAgentMention('@researcher line one\nline two', registry);
    expect(result).not.toBeNull();
    expect(result!.prompt).toContain('line one');
    expect(result!.prompt).toContain('line two');
  });

  it('trims leading/trailing whitespace from entire input', () => {
    const result = parseAgentMention('  @researcher hello  ', registry);
    expect(result).not.toBeNull();
    expect(result!.agent.name).toBe('researcher');
  });

  it('returns null for @mention not at start', () => {
    expect(parseAgentMention('hey @researcher do stuff', registry)).toBeNull();
  });

  it('returns null for empty prompt after trim', () => {
    // regex requires \s+ then at least one char, so pure whitespace won't match
    expect(parseAgentMention('@researcher   ', registry)).toBeNull();
  });
});

describe('extractMentions', () => {
  const registry = makeRegistry(['coder', 'planner', 'my-agent']);
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'uplnk-extract-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns empty payload for plain text', () => {
    const out = extractMentions('hello there, friend', registry, tmp);
    expect(out.text).toBe('hello there, friend');
    expect(out.addressees).toEqual([]);
    expect(out.attachments).toEqual([]);
  });

  it('collects multiple @agent addressees in order, deduped', () => {
    const out = extractMentions('ask @coder and @planner and @coder again', registry, tmp);
    expect(out.addressees).toEqual(['coder', 'planner']);
  });

  it('drops unknown agent names silently', () => {
    const out = extractMentions('hi @coder and @nobody', registry, tmp);
    expect(out.addressees).toEqual(['coder']);
  });

  it('does not match email-style user@host tokens', () => {
    // "@host" is only recognised after start-of-text or whitespace, so
    // `user@host` contributes no agent token.
    const out = extractMentions('email me at user@host', registry, tmp);
    expect(out.addressees).toEqual([]);
  });

  it('reads a relative path attachment and reports bytes + content', () => {
    writeFileSync(join(tmp, 'a.txt'), 'hello world\n');
    const out = extractMentions('take a look at @./a.txt please', registry, tmp);
    expect(out.attachments).toHaveLength(1);
    const att = out.attachments[0]!;
    expect(att.relPath).toBe('a.txt');
    expect(att.content).toBe('hello world\n');
    expect(att.bytes).toBe(12);
    expect(att.truncated).toBe(false);
  });

  it('truncates oversized files', () => {
    writeFileSync(join(tmp, 'big.txt'), 'x'.repeat(2000));
    const out = extractMentions('see @./big.txt', registry, tmp, { maxFileBytes: 500 });
    const att = out.attachments[0]!;
    expect(att.truncated).toBe(true);
    expect(att.content!.length).toBe(500);
    expect(att.bytes).toBe(2000);
  });

  it('marks binary files as unavailable (content=null)', () => {
    const bin = Buffer.concat([Buffer.from('hdr\0'), Buffer.alloc(10, 0xff)]);
    writeFileSync(join(tmp, 'img.bin'), bin);
    const out = extractMentions('check @./img.bin', registry, tmp);
    const att = out.attachments[0]!;
    expect(att.content).toBeNull();
    expect(att.error).toMatch(/binary/);
  });

  it('includes missing files with an error, not crash', () => {
    const out = extractMentions('see @./nope.txt', registry, tmp);
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0]!.content).toBeNull();
    expect(out.attachments[0]!.error).toBeDefined();
  });

  it('enforces maxAttachments', () => {
    for (let i = 0; i < 20; i++) writeFileSync(join(tmp, `f${i}.txt`), `#${i}`);
    const text = Array.from({ length: 20 }, (_, i) => `@./f${i}.txt`).join(' ');
    const out = extractMentions(text, registry, tmp, { maxAttachments: 3 });
    expect(out.attachments).toHaveLength(3);
  });

  it('dedupes attachments by absolute path', () => {
    writeFileSync(join(tmp, 'same.txt'), 'x');
    const out = extractMentions('@./same.txt and @./same.txt again', registry, tmp);
    expect(out.attachments).toHaveLength(1);
  });

  it('resolves nested relative paths', () => {
    mkdirSync(join(tmp, 'sub'));
    writeFileSync(join(tmp, 'sub/inner.txt'), 'nested');
    const out = extractMentions('read @./sub/inner.txt', registry, tmp);
    expect(out.attachments[0]!.content).toBe('nested');
    expect(out.attachments[0]!.relPath).toBe('sub/inner.txt');
  });

  it('leaves user text verbatim', () => {
    const input = 'hey @coder read @./x.txt and @./y.txt';
    writeFileSync(join(tmp, 'x.txt'), 'a');
    writeFileSync(join(tmp, 'y.txt'), 'b');
    const out = extractMentions(input, registry, tmp);
    expect(out.text).toBe(input);
  });
});

describe('formatAttachmentsForContext', () => {
  it('returns empty string when no attachments', () => {
    expect(formatAttachmentsForContext([])).toBe('');
  });

  it('wraps attachments in a tag block with fenced content', () => {
    const out = formatAttachmentsForContext([
      {
        token: '@./a.txt',
        absPath: '/tmp/a.txt',
        relPath: 'a.txt',
        content: 'hello',
        bytes: 5,
        truncated: false,
      },
    ]);
    expect(out).toContain('<attachments>');
    expect(out).toContain('<file path="a.txt" bytes="5">');
    expect(out).toContain('hello');
    expect(out).toContain('</file>');
    expect(out).toContain('</attachments>');
  });

  it('notes truncation', () => {
    const out = formatAttachmentsForContext([
      {
        token: '@./big.txt',
        absPath: '/tmp/big.txt',
        relPath: 'big.txt',
        content: 'xxx',
        bytes: 100,
        truncated: true,
      },
    ]);
    expect(out).toMatch(/truncated/);
  });

  it('notes unavailable files', () => {
    const out = formatAttachmentsForContext([
      {
        token: '@./missing.txt',
        absPath: '/tmp/missing.txt',
        relPath: 'missing.txt',
        content: null,
        bytes: 0,
        truncated: false,
        error: 'ENOENT',
      },
    ]);
    expect(out).toMatch(/unavailable.*ENOENT/);
  });
});
