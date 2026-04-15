/**
 * Tests for packages/app/src/altergo/sessions/geminiScanner.ts
 *
 * parseGeminiSessionFile handles the JSON format (messages/history/conversation
 * keys), a JSONL fallback, multiple content extraction strategies (parts, content,
 * text), and role normalisation ('model' → 'assistant').
 *
 * Strategy: real temp-dir I/O. The parser only does synchronous fs reads, so
 * there is nothing to mock at the module boundary.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  createFakeAltergoHome,
  makeGeminiSession,
} from '../../../__tests__/fixtures/altergoHome.js';
import {
  parseGeminiSessionFile,
  scanGeminiSessions,
} from '../geminiScanner.js';

// ─── parseGeminiSessionFile ───────────────────────────────────────────────────

describe('parseGeminiSessionFile', () => {
  let fake = createFakeAltergoHome();

  afterEach(() => {
    fake.cleanup();
    fake = createFakeAltergoHome();
  });

  it('returns empty array when file does not exist', () => {
    expect(parseGeminiSessionFile('/no/such/file.json')).toEqual([]);
  });

  it('returns empty array for a file containing invalid JSON (not JSONL either)', () => {
    fake.addAccount('alice', ['gemini']);
    const dir = join(fake.accountsDir, 'alice', '.gemini', 'tmp');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'bad.json');
    writeFileSync(filePath, '{ this is not json at all }}}', 'utf-8');

    // invalid JSON and no valid JSONL lines → empty
    expect(parseGeminiSessionFile(filePath)).toEqual([]);
  });

  it('returns empty array for an empty file', () => {
    fake.addAccount('alice', ['gemini']);
    const filePath = fake.addGeminiSession('alice', 'empty', { messages: [] });
    expect(parseGeminiSessionFile(filePath)).toEqual([]);
  });

  it('parses messages array with parts[].text extraction', () => {
    fake.addAccount('alice', ['gemini']);
    const filePath = fake.addGeminiSession(
      'alice',
      'basic',
      makeGeminiSession([
        { role: 'user', text: 'Hello Gemini' },
        { role: 'model', text: 'Hello!' },
      ]),
    );

    const msgs = parseGeminiSessionFile(filePath);

    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'Hello Gemini' });
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: 'Hello!' });
  });

  it('maps "model" role to "assistant"', () => {
    fake.addAccount('alice', ['gemini']);
    const filePath = fake.addGeminiSession('alice', 'model-role', {
      messages: [{ role: 'model', parts: [{ text: 'I am the model' }] }],
    });

    const msgs = parseGeminiSessionFile(filePath);

    expect(msgs[0]!.role).toBe('assistant');
  });

  it('accepts "assistant" role directly (newer format)', () => {
    fake.addAccount('alice', ['gemini']);
    const filePath = fake.addGeminiSession('alice', 'assistant-role', {
      messages: [{ role: 'assistant', parts: [{ text: 'direct assistant' }] }],
    });

    const msgs = parseGeminiSessionFile(filePath);

    expect(msgs[0]!.role).toBe('assistant');
    expect(msgs[0]!.content).toBe('direct assistant');
  });

  it('skips messages with unknown roles', () => {
    fake.addAccount('alice', ['gemini']);
    const filePath = fake.addGeminiSession('alice', 'unknown-role', {
      messages: [
        { role: 'system', content: 'system message' },
        { role: 'user', parts: [{ text: 'valid user' }] },
        { role: 'function', parts: [{ text: 'tool result' }] },
      ],
    });

    const msgs = parseGeminiSessionFile(filePath);

    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe('user');
  });

  it('concatenates multiple parts[].text values without separator', () => {
    fake.addAccount('alice', ['gemini']);
    const filePath = fake.addGeminiSession('alice', 'multi-parts', {
      messages: [
        {
          role: 'user',
          parts: [{ text: 'Part one. ' }, { text: 'Part two.' }],
        },
      ],
    });

    const msgs = parseGeminiSessionFile(filePath);

    expect(msgs[0]!.content).toBe('Part one. Part two.');
  });

  it('falls back to content string field when parts is absent', () => {
    fake.addAccount('alice', ['gemini']);
    const filePath = fake.addGeminiSession('alice', 'content-field', {
      messages: [{ role: 'user', content: 'flat content string' }],
    });

    const msgs = parseGeminiSessionFile(filePath);

    expect(msgs[0]!.content).toBe('flat content string');
  });

  it('falls back to text string field when parts and content are absent', () => {
    fake.addAccount('alice', ['gemini']);
    const filePath = fake.addGeminiSession('alice', 'text-field', {
      messages: [{ role: 'model', text: 'direct text field' }],
    });

    const msgs = parseGeminiSessionFile(filePath);

    expect(msgs[0]!.content).toBe('direct text field');
  });

  it('reads from the "history" key when "messages" is absent', () => {
    fake.addAccount('alice', ['gemini']);
    const dir = join(fake.accountsDir, 'alice', '.gemini', 'tmp');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'history-key.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        history: [{ role: 'user', parts: [{ text: 'from history key' }] }],
      }),
      'utf-8',
    );

    const msgs = parseGeminiSessionFile(filePath);

    expect(msgs[0]!.content).toBe('from history key');
  });

  it('reads from the "conversation" key when "messages" and "history" are absent', () => {
    fake.addAccount('alice', ['gemini']);
    const dir = join(fake.accountsDir, 'alice', '.gemini', 'tmp');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'conv-key.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        conversation: [{ role: 'user', parts: [{ text: 'from conversation key' }] }],
      }),
      'utf-8',
    );

    const msgs = parseGeminiSessionFile(filePath);

    expect(msgs[0]!.content).toBe('from conversation key');
  });

  it('preserves timestamp when present on a message', () => {
    fake.addAccount('alice', ['gemini']);
    const ts = '2024-06-01T12:00:00.000Z';
    const filePath = fake.addGeminiSession('alice', 'with-ts', {
      messages: [{ role: 'user', parts: [{ text: 'hello' }], timestamp: ts }],
    });

    const msgs = parseGeminiSessionFile(filePath);

    expect(msgs[0]).toMatchObject({ role: 'user', content: 'hello', createdAt: ts });
  });

  it('falls back to JSONL parsing when top-level JSON is not an object', () => {
    fake.addAccount('alice', ['gemini']);
    const dir = join(fake.accountsDir, 'alice', '.gemini', 'tmp');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'jsonl-fallback.jsonl');
    const lines = [
      JSON.stringify({ role: 'user', parts: [{ text: 'jsonl line 1' }] }),
      JSON.stringify({ role: 'model', parts: [{ text: 'jsonl reply' }] }),
    ].join('\n');
    writeFileSync(filePath, lines, 'utf-8');

    const msgs = parseGeminiSessionFile(filePath);

    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.content).toBe('jsonl line 1');
    expect(msgs[1]!.role).toBe('assistant');
  });
});

// ─── scanGeminiSessions ───────────────────────────────────────────────────────

describe('scanGeminiSessions', () => {
  let fake = createFakeAltergoHome();

  afterEach(() => {
    fake.cleanup();
    fake = createFakeAltergoHome();
  });

  it('returns empty array when account has no .gemini/tmp directory', () => {
    fake.addAccount('bob', []); // no .gemini dir
    expect(scanGeminiSessions(fake.home, 'bob')).toEqual([]);
  });

  it('returns empty array for a non-existent account', () => {
    expect(scanGeminiSessions(fake.home, 'nobody')).toEqual([]);
  });

  it('discovers a session JSON file directly in tmp/', () => {
    fake.addAccount('carol', ['gemini']);
    fake.addGeminiSession(
      'carol',
      'my-session',
      makeGeminiSession([
        { role: 'user', text: 'What time is it?' },
        { role: 'model', text: 'I cannot check the time.' },
      ]),
    );

    const sessions = scanGeminiSessions(fake.home, 'carol');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.account).toBe('carol');
    expect(sessions[0]!.messageCount).toBe(2);
  });

  it('derives the title from the first user message', () => {
    fake.addAccount('carol', ['gemini']);
    fake.addGeminiSession(
      'carol',
      'titled',
      makeGeminiSession([{ role: 'user', text: 'Explain quantum entanglement please' }]),
    );

    const sessions = scanGeminiSessions(fake.home, 'carol');

    expect(sessions[0]!.title).toBe('Explain quantum entanglement please');
  });

  it('falls back to filename-without-extension as title when no user messages', () => {
    fake.addAccount('carol', ['gemini']);
    fake.addGeminiSession('carol', 'model-only', {
      messages: [{ role: 'model', parts: [{ text: 'no user here' }] }],
    });

    const sessions = scanGeminiSessions(fake.home, 'carol');

    expect(sessions[0]!.title).toBe('model-only');
  });

  it('skips entries that have no parseable messages', () => {
    fake.addAccount('carol', ['gemini']);
    const dir = join(fake.accountsDir, 'carol', '.gemini', 'tmp');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'empty.json'), JSON.stringify({ messages: [] }), 'utf-8');

    const sessions = scanGeminiSessions(fake.home, 'carol');

    expect(sessions).toHaveLength(0);
  });

  it('returns sessions sorted by lastActivity descending', () => {
    fake.addAccount('dave', ['gemini']);
    fake.addGeminiSession('dave', 'older', makeGeminiSession([{ role: 'user', text: 'old' }]));
    fake.addGeminiSession('dave', 'newer', makeGeminiSession([{ role: 'user', text: 'new' }]));

    const sessions = scanGeminiSessions(fake.home, 'dave');

    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.lastActivity.getTime()).toBeGreaterThanOrEqual(
      sessions[1]!.lastActivity.getTime(),
    );
  });

  it('scans one level deep into subdirectories inside tmp/', () => {
    fake.addAccount('eve', ['gemini']);
    const subDir = join(fake.accountsDir, 'eve', '.gemini', 'tmp', 'project-x');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'chat.json'),
      JSON.stringify(makeGeminiSession([{ role: 'user', text: 'deep file' }])),
      'utf-8',
    );

    const sessions = scanGeminiSessions(fake.home, 'eve');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.messages[0]!.content).toBe('deep file');
  });

  it('ignores non-.json/.jsonl files in tmp/', () => {
    fake.addAccount('frank', ['gemini']);
    const dir = join(fake.accountsDir, 'frank', '.gemini', 'tmp');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.txt'), 'not a session file', 'utf-8');
    writeFileSync(
      join(dir, 'real.json'),
      JSON.stringify(makeGeminiSession([{ role: 'user', text: 'valid' }])),
      'utf-8',
    );

    const sessions = scanGeminiSessions(fake.home, 'frank');

    expect(sessions).toHaveLength(1);
  });
});
