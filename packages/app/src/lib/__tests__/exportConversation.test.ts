import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportConversation } from '../exportConversation.js';
import type { Message } from '@uplnk/db';

// Minimal message fixtures — enough to exercise the exporter
const makeMessage = (id: string, role: Message['role'], content: string): Message => ({
  id,
  conversationId: 'conv-001',
  role,
  content,
  toolCalls: null,
  toolCallId: null,
  inputTokens: null,
  outputTokens: null,
  timeToFirstToken: null,
  senderAgentName: null,
  addresseeAgentName: null,
  agentRunId: null,
  turnId: null,
  createdAt: '2026-04-12T10:00:00Z',
});

const messages: Message[] = [
  makeMessage('m1', 'user', 'Hello, can you help me?'),
  makeMessage('m2', 'assistant', 'Of course! What do you need?'),
  makeMessage('m3', 'user', 'Explain TypeScript generics.'),
  makeMessage('m4', 'assistant', '```typescript\nfunction identity<T>(arg: T): T {\n  return arg;\n}\n```'),
];

describe('exportConversation — Markdown', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'uplnk-export-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a .md file', () => {
    const result = exportConversation(messages, {
      format: 'markdown',
      outputPath: join(tmpDir, 'test-export.md'),
      conversationTitle: 'Test Conversation',
    });
    expect(result.path).toBe(join(tmpDir, 'test-export.md'));
    expect(result.format).toBe('markdown');
  });

  it('includes message count (excluding system messages)', () => {
    const result = exportConversation(messages, {
      format: 'markdown',
      outputPath: join(tmpDir, 'out.md'),
    });
    expect(result.messageCount).toBe(4); // all 4 are user/assistant
  });

  it('markdown output contains the conversation title', () => {
    exportConversation(messages, {
      format: 'markdown',
      outputPath: join(tmpDir, 'out.md'),
      conversationTitle: 'My Chat Session',
    });
    const content = readFileSync(join(tmpDir, 'out.md'), 'utf-8');
    expect(content).toContain('My Chat Session');
  });

  it('markdown output contains user message content', () => {
    exportConversation(messages, {
      format: 'markdown',
      outputPath: join(tmpDir, 'out.md'),
    });
    const content = readFileSync(join(tmpDir, 'out.md'), 'utf-8');
    expect(content).toContain('Hello, can you help me?');
    expect(content).toContain('Explain TypeScript generics.');
  });

  it('markdown output contains assistant message content', () => {
    exportConversation(messages, {
      format: 'markdown',
      outputPath: join(tmpDir, 'out.md'),
    });
    const content = readFileSync(join(tmpDir, 'out.md'), 'utf-8');
    expect(content).toContain('Of course!');
  });
});

describe('exportConversation — JSON', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'uplnk-export-json-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes valid JSON', () => {
    exportConversation(messages, {
      format: 'json',
      outputPath: join(tmpDir, 'out.json'),
    });
    const raw = readFileSync(join(tmpDir, 'out.json'), 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('JSON output has correct shape', () => {
    exportConversation(messages, {
      format: 'json',
      outputPath: join(tmpDir, 'out.json'),
      conversationTitle: 'Test',
    });
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'out.json'), 'utf-8')) as {
      title: string;
      messageCount: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(parsed.title).toBe('Test');
    expect(parsed.messages).toHaveLength(4);
    expect(parsed.messages[0]?.role).toBe('user');
    expect(parsed.messages[0]?.content).toBe('Hello, can you help me?');
  });
});

describe('exportConversation — auto filename', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'uplnk-export-auto-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates a default filename when outputPath is not specified', () => {
    // Change cwd to tmpDir so the auto-generated file lands there
    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const result = exportConversation(messages, { format: 'markdown' });
      expect(result.path).toMatch(/\.md$/);
      expect(result.path).toContain('uplnk-');
    } finally {
      process.chdir(origCwd);
    }
  });
});
