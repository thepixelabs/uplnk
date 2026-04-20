/**
 * EphemeralRegistry — precedence + per-conversation isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('@uplnk/db', async () => {
  return await vi.importActual<typeof import('@uplnk/db')>('@uplnk/db');
});

import { conversations, type Db } from '@uplnk/db';
import type { AgentDef, IAgentRegistry } from '../types.js';
import { EphemeralRegistry } from '../ephemeralRegistry.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../db/migrations',
);

function makeAgent(name: string, overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: '',
    model: 'inherit',
    maxDepth: 2,
    memory: 'none',
    color: 'cyan',
    icon: '🤖',
    userInvocable: true,
    maxTurns: 5,
    timeoutMs: 60_000,
    source: 'builtin',
    sourcePath: `/${name}.md`,
    ...overrides,
  };
}

function makeBase(agents: AgentDef[]): IAgentRegistry {
  return {
    list: () => agents,
    get: (n) => agents.find((a) => a.name === n),
    reload: async () => {},
  };
}

describe('EphemeralRegistry', () => {
  let sqlite: Database.Database;
  let db: Db;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite) as unknown as Db;
    migrate(db as never, { migrationsFolder: MIGRATIONS_DIR });
    db.insert(conversations).values({ id: 'c1', title: 't' }).run();
    db.insert(conversations).values({ id: 'c2', title: 't' }).run();
  });

  afterEach(() => sqlite.close());

  it('list() returns base agents when no ephemerals exist', () => {
    const reg = new EphemeralRegistry({
      base: makeBase([makeAgent('coder'), makeAgent('planner')]),
      conversationId: 'c1',
      db,
    });
    expect(reg.list().map((a) => a.name).sort()).toEqual(['coder', 'planner']);
  });

  it('base agents take precedence — ephemeral cannot shadow builtin', () => {
    const reg = new EphemeralRegistry({
      base: makeBase([makeAgent('coder', { description: 'base coder' })]),
      conversationId: 'c1',
      db,
    });
    // Ephemeral 'coder' would shadow — must throw.
    expect(() =>
      reg.create({
        name: 'coder',
        systemPrompt: 'rogue',
        firstMessage: 'hi',
      }),
    ).toThrow(/already belongs/);
  });

  it('create() appends an ephemeral that list() + get() surface', () => {
    const reg = new EphemeralRegistry({
      base: makeBase([makeAgent('coder')]),
      conversationId: 'c1',
      db,
    });
    reg.create({
      name: 'fresh-one',
      systemPrompt: 'be helpful',
      firstMessage: 'hello',
    });
    const names = reg.list().map((a) => a.name).sort();
    expect(names).toEqual(['coder', 'fresh-one']);
    expect(reg.get('fresh-one')?.systemPrompt).toBe('be helpful');
  });

  it('rejects duplicate ephemeral names within the same conversation', () => {
    const reg = new EphemeralRegistry({
      base: makeBase([]),
      conversationId: 'c1',
      db,
    });
    reg.create({ name: 'x', systemPrompt: '', firstMessage: '' });
    expect(() =>
      reg.create({ name: 'x', systemPrompt: '', firstMessage: '' }),
    ).toThrow(/already exists/);
  });

  it('isolates ephemerals by conversation id', () => {
    const r1 = new EphemeralRegistry({
      base: makeBase([]),
      conversationId: 'c1',
      db,
    });
    const r2 = new EphemeralRegistry({
      base: makeBase([]),
      conversationId: 'c2',
      db,
    });
    r1.create({ name: 'only-in-c1', systemPrompt: '', firstMessage: '' });
    expect(r2.get('only-in-c1')).toBeUndefined();
    expect(r1.get('only-in-c1')).not.toBeUndefined();
  });

  it('rehydrates ephemerals from DB on a fresh instance', () => {
    const r1 = new EphemeralRegistry({
      base: makeBase([]),
      conversationId: 'c1',
      db,
    });
    r1.create({ name: 'persisted', systemPrompt: 'keep me', firstMessage: '' });

    const r2 = new EphemeralRegistry({
      base: makeBase([]),
      conversationId: 'c1',
      db,
    });
    expect(r2.get('persisted')?.systemPrompt).toBe('keep me');
  });
});
