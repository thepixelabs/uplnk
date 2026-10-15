/**
 * retrieve.ts — unit tests for memory retrieval blend.
 */

import { describe, it, expect } from 'vitest';
import { retrieve } from '../retrieve.js';
import type { IMemoryRegistry, MemoryDef } from '../types.js';

function mem(over: Partial<MemoryDef>): MemoryDef {
  const base: MemoryDef = {
    name: over.name ?? 'memory',
    description: over.description ?? 'a memory',
    pinned: over.pinned ?? false,
    category: over.category ?? 'fact',
    source: over.source ?? 'user-edit',
    createdAt: over.createdAt ?? '2026-06-01T00:00:00Z',
    sourcePath: over.sourcePath ?? `/tmp/${over.name ?? 'memory'}.md`,
    scope: over.scope ?? 'user',
  };
  if (over.lastUsed !== undefined) base.lastUsed = over.lastUsed;
  if (over.body !== undefined) base.body = over.body;
  return base;
}

function fakeRegistry(memories: MemoryDef[]): IMemoryRegistry {
  return {
    list: () => memories,
    get: (name) => memories.find((m) => m.name === name),
    reload: async () => undefined,
  };
}

const NOW = Date.parse('2026-06-03T12:00:00Z');

describe('retrieve', () => {
  it('returns empty when registry is empty', () => {
    expect(retrieve(fakeRegistry([]), 'anything', { nowMs: NOW })).toEqual([]);
  });

  it('returns ONLY pinned when query is empty', () => {
    const a = mem({ name: 'a', pinned: true });
    const b = mem({ name: 'b' });
    const result = retrieve(fakeRegistry([a, b]), '', { nowMs: NOW });
    expect(result.map((m) => m.name)).toEqual(['a']);
  });

  it('returns ONLY pinned when query is whitespace', () => {
    const a = mem({ name: 'a', pinned: true });
    const result = retrieve(fakeRegistry([a, mem({ name: 'b' })]), '   ', { nowMs: NOW });
    expect(result.map((m) => m.name)).toEqual(['a']);
  });

  it('always includes pinned memories first', () => {
    const pinned = mem({ name: 'pin', pinned: true, description: 'wholly unrelated' });
    const match = mem({ name: 'match', description: 'the user loves blueberries' });
    const result = retrieve(fakeRegistry([pinned, match]), 'blueberries', { nowMs: NOW });
    expect(result[0]!.name).toBe('pin');
    expect(result.map((m) => m.name)).toContain('match');
  });

  it('returns nothing for unrelated query and no pinned', () => {
    const unrelated = mem({ name: 'u', description: 'capital of france is paris' });
    const result = retrieve(fakeRegistry([unrelated]), 'quantum chromodynamics', { nowMs: NOW });
    expect(result).toEqual([]);
  });

  it('respects topK cap on non-pinned matches', () => {
    const items: MemoryDef[] = [];
    for (let i = 0; i < 10; i++) {
      items.push(mem({ name: `m${i}`, description: `prefers ${i} pnpm typescript bun` }));
    }
    const result = retrieve(fakeRegistry(items), 'pnpm typescript bun', { topK: 2, nowMs: NOW });
    expect(result.length).toBe(2);
  });

  it('topK 0 with non-empty query returns only pinned', () => {
    const a = mem({ name: 'a', pinned: true });
    const b = mem({ name: 'b', description: 'pnpm matters' });
    const result = retrieve(fakeRegistry([a, b]), 'pnpm', { topK: 0, nowMs: NOW });
    expect(result.map((m) => m.name)).toEqual(['a']);
  });

  it('keyword match boosts memories containing query tokens', () => {
    const hit = mem({ name: 'hit', description: 'user prefers pnpm', createdAt: '2026-01-01T00:00:00Z' });
    const miss = mem({ name: 'miss', description: 'unrelated content here' });
    const result = retrieve(fakeRegistry([hit, miss]), 'pnpm', { nowMs: NOW });
    expect(result[0]!.name).toBe('hit');
  });

  it('BM25 rewards rarer term matches over common ones', () => {
    const docs = [
      mem({ name: 'common1', description: 'the the the the the' }),
      mem({ name: 'common2', description: 'the the the the the' }),
      mem({ name: 'rare', description: 'the quokka quokka quokka' }),
    ];
    const result = retrieve(fakeRegistry(docs), 'quokka', { topK: 3, nowMs: NOW });
    expect(result[0]!.name).toBe('rare');
  });

  it('recency boost prefers a more recently used memory at score parity', () => {
    const recent = mem({
      name: 'recent',
      description: 'pnpm typescript',
      createdAt: '2026-06-01T00:00:00Z',
      lastUsed: '2026-06-03T00:00:00Z',
    });
    const old = mem({
      name: 'old',
      description: 'pnpm typescript',
      createdAt: '2025-01-01T00:00:00Z',
      lastUsed: '2025-01-01T00:00:00Z',
    });
    const result = retrieve(fakeRegistry([recent, old]), 'pnpm typescript', { topK: 2, nowMs: NOW });
    expect(result[0]!.name).toBe('recent');
  });

  it('queries match against memory body as well as description', () => {
    const m1 = mem({
      name: 'descmatch',
      description: 'general note',
      body: 'particularly about kubernetes operators',
    });
    const m2 = mem({ name: 'nomatch', description: 'irrelevant', body: 'also irrelevant' });
    const result = retrieve(fakeRegistry([m1, m2]), 'kubernetes operators', { nowMs: NOW });
    expect(result.map((m) => m.name)).toEqual(['descmatch']);
  });

  it('case-insensitive keyword match', () => {
    const m1 = mem({ name: 'cap', description: 'User prefers TYPESCRIPT' });
    const result = retrieve(fakeRegistry([m1]), 'typescript', { nowMs: NOW });
    expect(result.map((m) => m.name)).toEqual(['cap']);
  });

  it('returns pinned BEFORE non-pinned in output order', () => {
    const p = mem({ name: 'p', pinned: true, description: 'foo' });
    const np = mem({ name: 'np', description: 'foo bar baz' });
    const result = retrieve(fakeRegistry([np, p]), 'foo', { nowMs: NOW });
    expect(result.indexOf(p)).toBeLessThan(result.indexOf(np));
  });

  it('non-pinned with zero score is excluded even when topK has room', () => {
    const filler = mem({ name: 'filler', description: 'no relevance' });
    const result = retrieve(fakeRegistry([filler]), 'xyzzy', { topK: 5, nowMs: NOW });
    expect(result).toEqual([]);
  });

  it('handles a single very-old non-pinned memory without crashing on recency math', () => {
    const ancient = mem({
      name: 'ancient',
      description: 'pnpm',
      createdAt: '2000-01-01T00:00:00Z',
    });
    const result = retrieve(fakeRegistry([ancient]), 'pnpm', { nowMs: NOW });
    expect(result.map((m) => m.name)).toEqual(['ancient']);
  });
});
