/**
 * Tests for searchConversations() — full-text search across conversation
 * title and message content with LIKE wildcards properly escaped.
 *
 * Each test gets a fresh in-memory database via createMigratedDb().
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createMigratedDb } from './setup.js';
import type { Db } from '../client.js';
import {
  createConversation,
  searchConversations,
  listConversations,
  softDeleteConversation,
  insertMessage,
} from '../queries.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function seedConversation(
  db: Db,
  overrides: Partial<{ id: string; title: string; updatedAt: string }> = {},
) {
  return createConversation(db, {
    id: overrides.id ?? crypto.randomUUID(),
    title: overrides.title ?? 'Test conversation',
    ...(overrides.updatedAt !== undefined ? { updatedAt: overrides.updatedAt } : {}),
  });
}

function seedMessage(
  db: Db,
  conversationId: string,
  content: string,
  role = 'user',
) {
  return insertMessage(db, {
    id: crypto.randomUUID(),
    conversationId,
    role,
    content,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('searchConversations — empty query', () => {
  let db: Db;
  beforeEach(() => { db = createMigratedDb(); });

  it('returns the same result as listConversations when query is empty string', () => {
    seedConversation(db, { title: 'Alpha' });
    seedConversation(db, { title: 'Beta' });
    const listed = listConversations(db);
    const searched = searchConversations(db, '');
    expect(searched.map((c) => c.id)).toEqual(listed.map((c) => c.id));
  });

  it('returns the same result as listConversations when query is whitespace only', () => {
    seedConversation(db, { title: 'Gamma' });
    const listed = listConversations(db);
    const searched = searchConversations(db, '   ');
    expect(searched.map((c) => c.id)).toEqual(listed.map((c) => c.id));
  });

  it('returns empty array when no conversations exist', () => {
    expect(searchConversations(db, '')).toEqual([]);
  });
});

describe('searchConversations — title match', () => {
  let db: Db;
  beforeEach(() => { db = createMigratedDb(); });

  it('returns conversations whose title contains the query', () => {
    const webhookConv = seedConversation(db, { title: 'Debug webhook handler' });
    seedConversation(db, { title: 'Refactor auth module' });
    const results = searchConversations(db, 'webhook');
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(webhookConv.id);
  });

  it('is case-insensitive for title matches (SQLite LIKE default)', () => {
    const conv = seedConversation(db, { title: 'Deploy to Production' });
    const results = searchConversations(db, 'production');
    expect(results.some((c) => c.id === conv.id)).toBe(true);
  });

  it('matches partial title substrings', () => {
    const conv = seedConversation(db, { title: 'Kubernetes cluster setup' });
    const results = searchConversations(db, 'cluster');
    expect(results.some((c) => c.id === conv.id)).toBe(true);
  });

  it('returns no matches when query does not match any title or content', () => {
    seedConversation(db, { title: 'Auth service refactor' });
    seedConversation(db, { title: 'CI pipeline' });
    const results = searchConversations(db, 'xyzzy-no-match');
    expect(results).toHaveLength(0);
  });
});

describe('searchConversations — message content match', () => {
  let db: Db;
  beforeEach(() => { db = createMigratedDb(); });

  it('returns conversations whose message content contains the query', () => {
    const conv = seedConversation(db, { title: 'General chat' });
    seedMessage(db, conv.id, 'How do I configure Redis cluster?');
    seedConversation(db, { title: 'Unrelated topic' });

    const results = searchConversations(db, 'Redis');
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(conv.id);
  });

  it('matches message content even when title does not match', () => {
    const conv = seedConversation(db, { title: 'Daily standup notes' });
    seedMessage(db, conv.id, 'Blocked on CORS issue in the API gateway');
    const results = searchConversations(db, 'CORS');
    expect(results.some((c) => c.id === conv.id)).toBe(true);
  });

  it('de-duplicates: a conversation matched by both title and content appears once', () => {
    const conv = seedConversation(db, { title: 'GraphQL schema design' });
    seedMessage(db, conv.id, 'We should use GraphQL subscriptions here');
    const results = searchConversations(db, 'GraphQL');
    expect(results.filter((c) => c.id === conv.id)).toHaveLength(1);
  });

  it('matches content from any message in the conversation', () => {
    const conv = seedConversation(db, { title: 'Architecture discussion' });
    seedMessage(db, conv.id, 'First message about nothing special');
    seedMessage(db, conv.id, 'Second message mentioning Kafka topic partitions', 'assistant');
    const results = searchConversations(db, 'Kafka');
    expect(results.some((c) => c.id === conv.id)).toBe(true);
  });
});

describe('searchConversations — soft-deleted conversations excluded', () => {
  let db: Db;
  beforeEach(() => { db = createMigratedDb(); });

  it('excludes soft-deleted conversations from results', () => {
    const conv = seedConversation(db, { title: 'Old project notes' });
    softDeleteConversation(db, conv.id);
    const results = searchConversations(db, 'project');
    expect(results.find((c) => c.id === conv.id)).toBeUndefined();
  });

  it('excludes soft-deleted conversations matched by message content', () => {
    const conv = seedConversation(db, { title: 'Ephemeral session' });
    seedMessage(db, conv.id, 'Discussing Terraform plan output');
    softDeleteConversation(db, conv.id);
    const results = searchConversations(db, 'Terraform');
    expect(results.find((c) => c.id === conv.id)).toBeUndefined();
  });
});

describe('searchConversations — ordering', () => {
  let db: Db;
  beforeEach(() => { db = createMigratedDb(); });

  it('orders results by updatedAt descending', () => {
    createConversation(db, { id: 'older', title: 'Docker compose setup', updatedAt: '2024-01-01T00:00:00.000Z' });
    createConversation(db, { id: 'newer', title: 'Docker swarm notes', updatedAt: '2024-06-01T00:00:00.000Z' });
    const results = searchConversations(db, 'Docker');
    expect(results[0]!.id).toBe('newer');
    expect(results[1]!.id).toBe('older');
  });
});

describe('searchConversations — limit parameter', () => {
  let db: Db;
  beforeEach(() => { db = createMigratedDb(); });

  it('respects a custom limit', () => {
    for (let i = 0; i < 10; i++) {
      seedConversation(db, { title: `Feature request ${i.toString()}` });
    }
    const results = searchConversations(db, 'Feature', 3);
    expect(results).toHaveLength(3);
  });

  it('defaults to 50 when no limit is provided', () => {
    for (let i = 0; i < 60; i++) {
      seedConversation(db, { title: `Spike ${i.toString()}` });
    }
    const results = searchConversations(db, 'Spike');
    expect(results.length).toBeLessThanOrEqual(50);
  });
});

describe('searchConversations — LIKE wildcard escaping', () => {
  let db: Db;
  beforeEach(() => { db = createMigratedDb(); });

  it('treats a literal % in the query as a percent sign, not a wildcard', () => {
    const pctConv = seedConversation(db, { title: 'Discount 50% off sale' });
    seedConversation(db, { title: 'Anything matches otherwise' });
    const results = searchConversations(db, '50%');
    // Should only match the conversation with literal "50%", not everything
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(pctConv.id);
  });

  it('treats a literal _ in the query as an underscore, not a single-char wildcard', () => {
    const underConv = seedConversation(db, { title: 'snake_case naming convention' });
    seedConversation(db, { title: 'camelCase naming convention' });
    const results = searchConversations(db, 'snake_case');
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(underConv.id);
  });

  it('treats a literal backslash in the query correctly', () => {
    const slashConv = seedConversation(db, { title: 'Windows path C:\\Users\\admin' });
    const results = searchConversations(db, 'C:\\Users');
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(slashConv.id);
  });
});
