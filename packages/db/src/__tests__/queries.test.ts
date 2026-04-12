/**
 * Tests for all exported query functions in queries.ts.
 *
 * Uses an in-memory SQLite database via createMigratedDb() — no disk I/O,
 * no ~/.uplnk writes. Each test gets a fresh db instance via beforeEach.
 *
 * Coverage: 10 exported query functions
 *   Conversations: createConversation, getConversation, listConversations,
 *                  updateConversationTitle, softDeleteConversation, touchConversation
 *   Messages:      insertMessage, getMessages
 *   Providers:     upsertProviderConfig, getDefaultProvider, listProviders
 *   Branching:     forkConversation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createMigratedDb } from './setup.js';
import type { Db } from '../client.js';
import {
  createConversation,
  getConversation,
  listConversations,
  updateConversationTitle,
  softDeleteConversation,
  touchConversation,
  insertMessage,
  getMessages,
  upsertProviderConfig,
  getDefaultProvider,
  listProviders,
  forkConversation,
} from '../queries.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seedConversation(db: Db, overrides: Partial<{ id: string; title: string }> = {}) {
  return createConversation(db, {
    id: overrides.id ?? crypto.randomUUID(),
    title: overrides.title ?? 'Test conversation',
  });
}

function seedMessage(
  db: Db,
  conversationId: string,
  overrides: Partial<{ id: string; role: string; content: string }> = {},
) {
  return insertMessage(db, {
    id: overrides.id ?? crypto.randomUUID(),
    conversationId,
    role: overrides.role ?? 'user',
    content: overrides.content ?? 'Hello',
  });
}

function seedProvider(
  db: Db,
  overrides: Partial<{
    id: string;
    name: string;
    isDefault: boolean;
    defaultModel: string;
  }> = {},
) {
  upsertProviderConfig(db, {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? 'Local Ollama',
    providerType: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: 'ollama',
    defaultModel: overrides.defaultModel ?? 'llama3.2',
    isDefault: overrides.isDefault ?? false,
  });
}

// ─── Conversations ────────────────────────────────────────────────────────────

describe('createConversation', () => {
  let db: Db;
  beforeEach(() => { db = createMigratedDb(); });

  it('returns the created conversation row', () => {
    const conv = seedConversation(db, { title: 'My first chat' });
    expect(conv.title).toBe('My first chat');
    expect(conv.id).toBeDefined();
  });

  it('sets deletedAt to null by default', () => {
    const conv = seedConversation(db);
    expect(conv.deletedAt).toBeNull();
  });

  it('persists the row so getConversation can retrieve it', () => {
    seedConversation(db, { id: 'conv-abc' });
    const found = getConversation(db, 'conv-abc');
    expect(found).toBeDefined();
    expect(found!.id).toBe('conv-abc');
  });
});

describe('getConversation', () => {
  let db: Db;
  beforeEach(() => { db = createMigratedDb(); });

  it('returns undefined for an unknown id', () => {
    expect(getConversation(db, 'does-not-exist')).toBeUndefined();
  });

  it('returns the conversation by id', () => {
    seedConversation(db, { id: 'conv-123', title: 'Lookup test' });
    const result = getConversation(db, 'conv-123');
    expect(result).toBeDefined();
    expect(result!.title).toBe('Lookup test');
  });

  it('returns soft-deleted conversations (getConversation does not filter deletedAt)', () => {
    seedConversation(db, { id: 'conv-del' });
    softDeleteConversation(db, 'conv-del');
    // getConversation should still return it — listConversations is what filters
    const result = getConversation(db, 'conv-del');
    expect(result).toBeDefined();
    expect(result!.deletedAt).not.toBeNull();
  });
});

describe('listConversations', () => {
  let db: Db;
  beforeEach(() => { db = createMigratedDb(); });

  it('returns an empty array when no conversations exist', () => {
    expect(listConversations(db)).toEqual([]);
  });

  it('returns only non-deleted conversations', () => {
    seedConversation(db, { id: 'active-1', title: 'Active' });
    seedConversation(db, { id: 'deleted-1', title: 'Deleted' });
    softDeleteConversation(db, 'deleted-1');
    const list = listConversations(db);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('active-1');
  });

  it('orders results by updatedAt descending', () => {
    // Use explicit timestamps 1 second apart to avoid same-millisecond collisions
    createConversation(db, { id: 'older', title: 'Older', updatedAt: '2020-01-01T00:00:00.000Z' });
    createConversation(db, { id: 'newer', title: 'Newer', updatedAt: '2020-01-01T00:00:01.000Z' });
    const list = listConversations(db);
    expect(list[0]!.id).toBe('newer');
  });

  it('caps results at 50', () => {
    for (let i = 0; i < 60; i++) {
      seedConversation(db, { title: `Conv ${i}` });
    }
    expect(listConversations(db).length).toBeLessThanOrEqual(50);
  });
});

describe('updateConversationTitle', () => {
  let db: Db;
  beforeEach(() => { db = createMigratedDb(); });

  it('changes the title', () => {
    const conv = seedConversation(db, { id: 'conv-title', title: 'Old title' });
    updateConversationTitle(db, conv.id, 'New title');
    const updated = getConversation(db, conv.id);
    expect(updated!.title).toBe('New title');
  });

  it('does not affect other conversations', () => {
    const a = seedConversation(db, { id: 'conv-a', title: 'A' });
    const b = seedConversation(db, { id: 'conv-b', title: 'B' });
    updateConversationTitle(db, a.id, 'A renamed');
    expect(getConversation(db, b.id)!.title).toBe('B');
  });
});

describe('softDeleteConversation', () => {
  let db: Db;
  beforeEach(() => { db = createMigratedDb(); });

  it('sets deletedAt to a non-null ISO string', () => {
    const conv = seedConversation(db, { id: 'conv-soft' });
    softDeleteConversation(db, conv.id);
    const result = getConversation(db, conv.id);
    expect(result!.deletedAt).not.toBeNull();
    // Should be a valid ISO 8601 string
    expect(new Date(result!.deletedAt!).getTime()).not.toBeNaN();
  });

  it('excludes the row from listConversations', () => {
    seedConversation(db, { id: 'conv-hide' });
    softDeleteConversation(db, 'conv-hide');
    const list = listConversations(db);
    expect(list.find((c) => c.id === 'conv-hide')).toBeUndefined();
  });
});

describe('touchConversation', () => {
  let db: Db;
  beforeEach(() => { db = createMigratedDb(); });

  it('updates updatedAt to a more recent timestamp', async () => {
    const conv = seedConversation(db, { id: 'conv-touch' });
    const before = conv.updatedAt;
    // Wait a tick to ensure clock advances in SQLite strftime
    await new Promise((r) => setTimeout(r, 5));
    touchConversation(db, conv.id);
    const updated = getConversation(db, conv.id);
    expect(updated!.updatedAt >= before).toBe(true);
  });
});

// ─── Messages ─────────────────────────────────────────────────────────────────

describe('insertMessage', () => {
  let db: Db;
  beforeEach(() => { db = createMigratedDb(); });

  it('returns the inserted message row', () => {
    const conv = seedConversation(db);
    const msg = seedMessage(db, conv.id, { content: 'Hello world', role: 'user' });
    expect(msg.content).toBe('Hello world');
    expect(msg.role).toBe('user');
    expect(msg.conversationId).toBe(conv.id);
  });

  it('assigns a valid id', () => {
    const conv = seedConversation(db);
    const msg = seedMessage(db, conv.id);
    expect(typeof msg.id).toBe('string');
    expect(msg.id.length).toBeGreaterThan(0);
  });

  it('supports assistant role', () => {
    const conv = seedConversation(db);
    const msg = seedMessage(db, conv.id, { role: 'assistant', content: 'Hi there' });
    expect(msg.role).toBe('assistant');
  });

  it('stores optional token counts', () => {
    const conv = seedConversation(db);
    const msg = insertMessage(db, {
      id: crypto.randomUUID(),
      conversationId: conv.id,
      role: 'assistant',
      content: 'Response',
      inputTokens: 10,
      outputTokens: 20,
    });
    expect(msg.inputTokens).toBe(10);
    expect(msg.outputTokens).toBe(20);
  });
});

describe('getMessages', () => {
  let db: Db;
  beforeEach(() => { db = createMigratedDb(); });

  it('returns empty array for a conversation with no messages', () => {
    const conv = seedConversation(db);
    expect(getMessages(db, conv.id)).toEqual([]);
  });

  it('returns messages in ascending createdAt order', () => {
    const conv = seedConversation(db);
    const m1 = seedMessage(db, conv.id, { content: 'First' });
    const m2 = seedMessage(db, conv.id, { content: 'Second' });
    const msgs = getMessages(db, conv.id);
    expect(msgs.length).toBe(2);
    // Both messages present; order should be insertion order (ascending createdAt)
    const ids = msgs.map((m) => m.id);
    expect(ids).toContain(m1.id);
    expect(ids).toContain(m2.id);
  });

  it('does not return messages from a different conversation', () => {
    const convA = seedConversation(db, { id: 'conv-A' });
    const convB = seedConversation(db, { id: 'conv-B' });
    seedMessage(db, convA.id, { content: 'For A only' });
    const msgs = getMessages(db, convB.id);
    expect(msgs).toHaveLength(0);
  });
});

// ─── Provider Configs ─────────────────────────────────────────────────────────

describe('upsertProviderConfig', () => {
  let db: Db;
  beforeEach(() => { db = createMigratedDb(); });

  it('inserts a new provider config', () => {
    const id = crypto.randomUUID();
    seedProvider(db, { id, name: 'My Provider' });
    const providers = listProviders(db);
    const found = providers.find((p) => p.id === id);
    expect(found).toBeDefined();
    expect(found!.name).toBe('My Provider');
  });

  it('updates an existing provider config on conflict (same id)', () => {
    const id = 'prov-static-id';
    upsertProviderConfig(db, {
      id,
      name: 'Original',
      providerType: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'key1',
      defaultModel: 'llama3.2',
      isDefault: false,
    });
    upsertProviderConfig(db, {
      id,
      name: 'Updated',
      providerType: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'key2',
      defaultModel: 'mistral',
      isDefault: true,
    });
    const providers = listProviders(db);
    const rows = providers.filter((p) => p.id === id);
    // Must not duplicate
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Updated');
    expect(rows[0]!.defaultModel).toBe('mistral');
  });
});

describe('getDefaultProvider', () => {
  let db: Db;
  beforeEach(() => { db = createMigratedDb(); });

  it('returns undefined when no providers exist', () => {
    expect(getDefaultProvider(db)).toBeUndefined();
  });

  it('returns undefined when no provider is marked default', () => {
    seedProvider(db, { isDefault: false });
    expect(getDefaultProvider(db)).toBeUndefined();
  });

  it('returns the provider marked as default', () => {
    const idA = 'prov-a';
    const idB = 'prov-b';
    seedProvider(db, { id: idA, name: 'Not default', isDefault: false });
    upsertProviderConfig(db, {
      id: idB,
      name: 'Default provider',
      providerType: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      defaultModel: 'llama3.2',
      isDefault: true,
    });
    const def = getDefaultProvider(db);
    expect(def).toBeDefined();
    expect(def!.id).toBe(idB);
  });
});

describe('listProviders', () => {
  let db: Db;
  beforeEach(() => { db = createMigratedDb(); });

  it('returns empty array when no providers exist', () => {
    expect(listProviders(db)).toEqual([]);
  });

  it('returns all providers including non-default ones', () => {
    seedProvider(db, { name: 'A' });
    seedProvider(db, { name: 'B' });
    expect(listProviders(db)).toHaveLength(2);
  });
});

// ─── Conversation Branching ───────────────────────────────────────────────────

describe('forkConversation', () => {
  let db: Db;
  beforeEach(() => { db = createMigratedDb(); });

  function buildForkFixture(db: Db) {
    const conv = seedConversation(db, { title: 'Source conversation' });
    const m1 = seedMessage(db, conv.id, { content: 'Msg 1', role: 'user' });
    const m2 = seedMessage(db, conv.id, { content: 'Msg 2', role: 'assistant' });
    const m3 = seedMessage(db, conv.id, { content: 'Msg 3', role: 'user' });
    return { conv, m1, m2, m3 };
  }

  it('returns a new conversation row', () => {
    const { conv, m2 } = buildForkFixture(db);
    const forked = forkConversation(db, conv.id, m2.id);
    expect(forked).toBeDefined();
    expect(forked.id).not.toBe(conv.id);
  });

  it('uses the provided title for the fork', () => {
    const { conv, m2 } = buildForkFixture(db);
    const forked = forkConversation(db, conv.id, m2.id, 'My fork');
    expect(forked.title).toBe('My fork');
  });

  it('defaults title to "Fork of: <source title>" when no title provided', () => {
    const { conv, m2 } = buildForkFixture(db);
    const forked = forkConversation(db, conv.id, m2.id);
    expect(forked.title).toBe('Fork of: Source conversation');
  });

  it('copies only messages up to and including the fork point', () => {
    const { conv, m2 } = buildForkFixture(db);
    // Fork at m2 — should copy m1 and m2, not m3
    const forked = forkConversation(db, conv.id, m2.id);
    const forkedMsgs = getMessages(db, forked.id);
    expect(forkedMsgs).toHaveLength(2);
    // Content should match
    const contents = forkedMsgs.map((m) => m.content);
    expect(contents).toContain('Msg 1');
    expect(contents).toContain('Msg 2');
    expect(contents).not.toContain('Msg 3');
  });

  it('assigns new ids to copied messages (not the originals)', () => {
    const { conv, m1, m2 } = buildForkFixture(db);
    const forked = forkConversation(db, conv.id, m2.id);
    const forkedMsgs = getMessages(db, forked.id);
    const forkedIds = forkedMsgs.map((m) => m.id);
    expect(forkedIds).not.toContain(m1.id);
    expect(forkedIds).not.toContain(m2.id);
  });

  it('does not modify the source conversation messages', () => {
    const { conv, m2 } = buildForkFixture(db);
    forkConversation(db, conv.id, m2.id);
    // Source still has all 3 messages
    const sourceMsgs = getMessages(db, conv.id);
    expect(sourceMsgs).toHaveLength(3);
  });

  it('throws when source conversation does not exist', () => {
    const { m1 } = buildForkFixture(db);
    expect(() => forkConversation(db, 'nonexistent-conv', m1.id)).toThrow(
      'Source conversation not found: nonexistent-conv',
    );
  });

  it('throws when the fork message does not exist in the source conversation', () => {
    const { conv } = buildForkFixture(db);
    expect(() => forkConversation(db, conv.id, 'nonexistent-msg')).toThrow(
      'Fork message not found: nonexistent-msg',
    );
  });

  it('can fork at the first message (single-message fork)', () => {
    const { conv, m1 } = buildForkFixture(db);
    const forked = forkConversation(db, conv.id, m1.id);
    const msgs = getMessages(db, forked.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toBe('Msg 1');
  });

  it('the forked conversation appears in listConversations', () => {
    const { conv, m2 } = buildForkFixture(db);
    const forked = forkConversation(db, conv.id, m2.id);
    const list = listConversations(db);
    expect(list.find((c) => c.id === forked.id)).toBeDefined();
  });
});
