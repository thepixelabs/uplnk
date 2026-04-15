/**
 * Tests for packages/app/src/altergo/sessions/claudeCodeScanner.ts
 *
 * parseClaudeSessionFile handles three JSONL format generations and must
 * never throw regardless of the file contents. scanClaudeCodeSessions builds
 * the session list from a real directory tree.
 *
 * Strategy: real temp-dir I/O via createFakeAltergoHome — no fs mocking.
 * The scanner uses only synchronous node:fs calls, so there is nothing async
 * to wait for and nothing that needs mocking at the module boundary.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  createFakeAltergoHome,
  makeClaudeJSONLLine,
} from '../../../__tests__/fixtures/altergoHome.js';
import {
  parseClaudeSessionFile,
  scanClaudeCodeSessions,
} from '../claudeCodeScanner.js';

// ─── parseClaudeSessionFile ───────────────────────────────────────────────────

describe('parseClaudeSessionFile', () => {
  let fake = createFakeAltergoHome();

  afterEach(() => {
    fake.cleanup();
    fake = createFakeAltergoHome();
  });

  it('returns empty array for a file that does not exist', () => {
    const result = parseClaudeSessionFile('/does/not/exist/session.jsonl');
    expect(result).toEqual([]);
  });

  it('returns empty array for an empty file', () => {
    fake.addAccount('alice', ['claude-code']);
    const filePath = fake.addClaudeSession('alice', 'sess-empty', []);
    const result = parseClaudeSessionFile(filePath);
    expect(result).toEqual([]);
  });

  it('parses nested format: { type, message: { role, content } }', () => {
    fake.addAccount('alice', ['claude-code']);
    const filePath = fake.addClaudeSession('alice', 'sess-nested', [
      makeClaudeJSONLLine('user', 'Hello'),
      makeClaudeJSONLLine('assistant', 'Hi there'),
    ]);

    const msgs = parseClaudeSessionFile(filePath);

    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'Hello' });
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: 'Hi there' });
  });

  it('parses flat role format: { role, content }', () => {
    fake.addAccount('alice', ['claude-code']);
    const filePath = fake.addClaudeSession('alice', 'sess-flat-role', [
      { role: 'user', content: 'flat user message' },
      { role: 'assistant', content: 'flat assistant reply' },
    ]);

    const msgs = parseClaudeSessionFile(filePath);

    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'flat user message' });
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: 'flat assistant reply' });
  });

  it('parses flat type format: { type, content } (older format)', () => {
    fake.addAccount('alice', ['claude-code']);
    const filePath = fake.addClaudeSession('alice', 'sess-flat-type', [
      { type: 'user', content: 'type-keyed user message' },
      { type: 'assistant', content: 'type-keyed assistant reply' },
    ]);

    const msgs = parseClaudeSessionFile(filePath);

    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'type-keyed user message' });
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: 'type-keyed assistant reply' });
  });

  it('parses parts[] content-block format: content is an array of { type, text } blocks', () => {
    fake.addAccount('alice', ['claude-code']);
    const filePath = fake.addClaudeSession('alice', 'sess-parts', [
      {
        type: 'message',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'First block. ' },
            { type: 'text', text: 'Second block.' },
          ],
        },
      },
    ]);

    const msgs = parseClaudeSessionFile(filePath);

    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[0]!.content).toBe('First block. Second block.');
  });

  it('preserves timestamp from the outer record when present in nested format', () => {
    // makeClaudeJSONLLine places timestamp inside the inner message object, but
    // the parser reads it from the outer wrapper record. Write the line manually
    // so the timestamp is in the correct position.
    fake.addAccount('alice', ['claude-code']);
    const ts = '2024-01-15T10:30:00.000Z';
    const dir = join(fake.accountsDir, 'alice', '.claude', 'projects', 'sess-ts');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'session.jsonl');
    writeFileSync(
      filePath,
      JSON.stringify({
        type: 'message',
        timestamp: ts,
        message: { role: 'user', content: 'timestamped' },
      }),
      'utf-8',
    );

    const msgs = parseClaudeSessionFile(filePath);

    expect(msgs[0]).toMatchObject({ role: 'user', content: 'timestamped', createdAt: ts });
  });

  it('preserves timestamp from flat format when present', () => {
    // In the flat format the timestamp sits on the same object as role/content
    fake.addAccount('alice', ['claude-code']);
    const ts = '2024-03-01T08:00:00.000Z';
    const filePath = fake.addClaudeSession('alice', 'sess-flat-ts', [
      // The timestamp field IS the outer field here (flat format has no inner message wrapper)
      { role: 'user', content: 'hello', timestamp: ts },
    ]);

    const msgs = parseClaudeSessionFile(filePath);

    expect(msgs[0]).toMatchObject({ role: 'user', content: 'hello', createdAt: ts });
  });

  it('omits createdAt when no timestamp is present', () => {
    fake.addAccount('alice', ['claude-code']);
    const filePath = fake.addClaudeSession('alice', 'sess-no-ts', [
      makeClaudeJSONLLine('user', 'no timestamp'),
    ]);

    const msgs = parseClaudeSessionFile(filePath);

    expect(msgs[0]).not.toHaveProperty('createdAt');
  });

  it('skips a single malformed JSON line and continues parsing valid lines', () => {
    fake.addAccount('alice', ['claude-code']);
    // addClaudeSession serialises objects; we need to write raw content
    const dir = join(fake.accountsDir, 'alice', '.claude', 'projects', 'sess-malformed');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'session.jsonl');
    const lines = [
      JSON.stringify(makeClaudeJSONLLine('user', 'before bad line')),
      'THIS IS NOT JSON }{{{',
      JSON.stringify(makeClaudeJSONLLine('assistant', 'after bad line')),
    ].join('\n');
    writeFileSync(filePath, lines, 'utf-8');

    const msgs = parseClaudeSessionFile(filePath);

    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.content).toBe('before bad line');
    expect(msgs[1]!.content).toBe('after bad line');
  });

  it('skips lines where role is neither user nor assistant', () => {
    fake.addAccount('alice', ['claude-code']);
    const filePath = fake.addClaudeSession('alice', 'sess-unknown-role', [
      { role: 'system', content: 'system prompt' },
      makeClaudeJSONLLine('user', 'actual user message'),
    ]);

    const msgs = parseClaudeSessionFile(filePath);

    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe('user');
  });

  it('skips lines with null or non-object values', () => {
    fake.addAccount('alice', ['claude-code']);
    const dir = join(fake.accountsDir, 'alice', '.claude', 'projects', 'sess-null');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'session.jsonl');
    writeFileSync(
      filePath,
      [
        'null',
        '42',
        '"a string"',
        JSON.stringify(makeClaudeJSONLLine('user', 'valid')),
      ].join('\n'),
      'utf-8',
    );

    const msgs = parseClaudeSessionFile(filePath);

    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe('valid');
  });

  it('ignores content blocks without a text property', () => {
    fake.addAccount('alice', ['claude-code']);
    const filePath = fake.addClaudeSession('alice', 'sess-no-text-block', [
      {
        type: 'message',
        message: {
          role: 'user',
          content: [
            { type: 'image', source: 'data:image/png;base64,abc' },
            { type: 'text', text: 'readable text' },
          ],
        },
      },
    ]);

    const msgs = parseClaudeSessionFile(filePath);

    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe('readable text');
  });

  it('skips a message with an empty parts[] array (no extractable text)', () => {
    fake.addAccount('alice', ['claude-code']);
    const filePath = fake.addClaudeSession('alice', 'sess-empty-parts', [
      { type: 'message', message: { role: 'user', content: [] } },
    ]);

    const msgs = parseClaudeSessionFile(filePath);

    expect(msgs).toHaveLength(0);
  });
});

// ─── scanClaudeCodeSessions ───────────────────────────────────────────────────

describe('scanClaudeCodeSessions', () => {
  let fake = createFakeAltergoHome();

  afterEach(() => {
    fake.cleanup();
    fake = createFakeAltergoHome();
  });

  it('returns empty array when account has no claude projects directory', () => {
    fake.addAccount('bob', []); // no .claude dir
    const sessions = scanClaudeCodeSessions(fake.home, 'bob');
    expect(sessions).toEqual([]);
  });

  it('returns empty array for a non-existent account', () => {
    const sessions = scanClaudeCodeSessions(fake.home, 'nobody');
    expect(sessions).toEqual([]);
  });

  it('discovers a single session with correct metadata', () => {
    fake.addAccount('carol', ['claude-code']);
    fake.addClaudeSession('carol', 'session-abc', [
      makeClaudeJSONLLine('user', 'What is the capital of France?'),
      makeClaudeJSONLLine('assistant', 'Paris.'),
    ]);

    const sessions = scanClaudeCodeSessions(fake.home, 'carol');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe('session-abc');
    expect(sessions[0]!.account).toBe('carol');
    expect(sessions[0]!.messageCount).toBe(2);
    expect(sessions[0]!.messages).toHaveLength(2);
  });

  it('derives title from first user message (truncated at 60 chars)', () => {
    fake.addAccount('carol', ['claude-code']);
    const longText = 'A'.repeat(80);
    fake.addClaudeSession('carol', 'session-long-title', [
      makeClaudeJSONLLine('user', longText),
    ]);

    const sessions = scanClaudeCodeSessions(fake.home, 'carol');

    expect(sessions[0]!.title).toHaveLength(60);
    expect(sessions[0]!.title).toBe('A'.repeat(60));
  });

  it('falls back to folder name as title when there are no user messages', () => {
    fake.addAccount('carol', ['claude-code']);
    fake.addClaudeSession('carol', 'my-folder-name', [
      makeClaudeJSONLLine('assistant', 'assistant only'),
    ]);

    const sessions = scanClaudeCodeSessions(fake.home, 'carol');

    expect(sessions[0]!.title).toBe('my-folder-name');
  });

  it('returns sessions sorted by lastActivity descending', () => {
    fake.addAccount('dave', ['claude-code']);
    // Create two sessions; modification times differ due to sequential writes
    fake.addClaudeSession('dave', 'sess-first', [makeClaudeJSONLLine('user', 'first')]);
    // Small sleep alternative: just add two sessions and verify sort contract
    fake.addClaudeSession('dave', 'sess-second', [makeClaudeJSONLLine('user', 'second')]);

    const sessions = scanClaudeCodeSessions(fake.home, 'dave');

    expect(sessions).toHaveLength(2);
    // The most recently modified session must come first
    const [a, b] = sessions;
    expect(a!.lastActivity.getTime()).toBeGreaterThanOrEqual(b!.lastActivity.getTime());
  });

  it('aggregates messages from multiple JSONL files in the same session folder', () => {
    fake.addAccount('eve', ['claude-code']);
    // addClaudeSession writes one file; we add a second manually
    fake.addClaudeSession('eve', 'multi-file', [makeClaudeJSONLLine('user', 'file 1')]);
    const sessionDir = join(fake.accountsDir, 'eve', '.claude', 'projects', 'multi-file');
    writeFileSync(
      join(sessionDir, 'extra.jsonl'),
      JSON.stringify(makeClaudeJSONLLine('assistant', 'file 2 reply')),
      'utf-8',
    );

    const sessions = scanClaudeCodeSessions(fake.home, 'eve');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.messageCount).toBe(2);
  });

  it('skips empty session folders (no JSONL files)', () => {
    fake.addAccount('frank', ['claude-code']);
    const emptyDir = join(fake.accountsDir, 'frank', '.claude', 'projects', 'empty-session');
    mkdirSync(emptyDir, { recursive: true });

    const sessions = scanClaudeCodeSessions(fake.home, 'frank');

    expect(sessions).toHaveLength(0);
  });

  it('includes the session path pointing to the session directory', () => {
    fake.addAccount('grace', ['claude-code']);
    fake.addClaudeSession('grace', 'path-check', [makeClaudeJSONLLine('user', 'hello')]);

    const sessions = scanClaudeCodeSessions(fake.home, 'grace');

    expect(sessions[0]!.path).toBe(
      join(fake.home, 'accounts', 'grace', '.claude', 'projects', 'path-check'),
    );
  });
});
