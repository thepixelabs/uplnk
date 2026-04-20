/**
 * EphemeralRegistry — wraps a base AgentRegistry with conversation-scoped
 * ad-hoc agents created at runtime via the `spawn_agent` tool.
 *
 * Lookup precedence: base registry (project > user > builtin) first, then
 * ephemeral. Ephemerals therefore cannot shadow disk-loaded agents — a
 * deliberate safety property so a spawn cannot impersonate a builtin name.
 *
 * Persistence: ephemerals are written to the `ephemeral_agents` table so
 * they survive process restart within the same conversation. The base
 * registry stays the authoritative source for durable agents.
 */

import { ulid } from 'ulid';
import {
  db as globalDb,
  ephemeralAgents,
  type Db,
  type EphemeralAgent,
} from '@uplnk/db';
import { eq } from 'drizzle-orm';
import type {
  AgentColor,
  AgentDef,
  EphemeralAgentSpec,
  IAgentRegistry,
} from './types.js';

interface EphemeralRegistryOpts {
  base: IAgentRegistry;
  conversationId: string;
  /** Injected DB handle (defaults to the global one). Exposed for tests. */
  db?: Db;
}

function ephemeralToDef(
  row: EphemeralAgent,
  fallbackColor: AgentColor = 'cyan',
  fallbackIcon = '🌀',
): AgentDef {
  let def: Partial<AgentDef> = {};
  try {
    def = JSON.parse(row.definitionJson) as Partial<AgentDef>;
  } catch {
    // Defensive: if the JSON is corrupt, render a minimally valid agent with
    // the stored name and no system prompt. Easier to recover from than a
    // hard load failure.
  }
  return {
    name: row.name,
    description: def.description ?? `Ephemeral agent ${row.name}`,
    systemPrompt: def.systemPrompt ?? '',
    model: def.model ?? 'inherit',
    maxDepth: def.maxDepth ?? 2,
    memory: def.memory ?? 'none',
    color: def.color ?? fallbackColor,
    icon: def.icon ?? fallbackIcon,
    userInvocable: def.userInvocable ?? false,
    maxTurns: def.maxTurns ?? 5,
    timeoutMs: def.timeoutMs ?? 120_000,
    source: 'project',
    sourcePath: `<ephemeral:${row.conversationId}>`,
    ...(def.tools !== undefined ? { tools: def.tools } : {}),
    ...(def.toolsDeny !== undefined ? { toolsDeny: def.toolsDeny } : {}),
    ...(def.agents !== undefined ? { agents: def.agents } : {}),
    ...(def.temperature !== undefined ? { temperature: def.temperature } : {}),
  };
}

export class EphemeralRegistry implements IAgentRegistry {
  private readonly base: IAgentRegistry;
  private readonly conversationId: string;
  private readonly db: Db;
  private cache: Map<string, AgentDef> | null = null;

  constructor(opts: EphemeralRegistryOpts) {
    this.base = opts.base;
    this.conversationId = opts.conversationId;
    this.db = opts.db ?? globalDb;
  }

  private ensureCache(): Map<string, AgentDef> {
    if (this.cache !== null) return this.cache;
    const rows = this.db
      .select()
      .from(ephemeralAgents)
      .where(eq(ephemeralAgents.conversationId, this.conversationId))
      .all();
    this.cache = new Map(rows.map((r) => [r.name, ephemeralToDef(r)]));
    return this.cache;
  }

  list(): AgentDef[] {
    const baseList = this.base.list();
    const names = new Set(baseList.map((a) => a.name));
    const extras: AgentDef[] = [];
    for (const agent of this.ensureCache().values()) {
      if (names.has(agent.name)) continue; // never shadow
      extras.push(agent);
    }
    return [...baseList, ...extras];
  }

  get(name: string): AgentDef | undefined {
    const fromBase = this.base.get(name);
    if (fromBase !== undefined) return fromBase;
    return this.ensureCache().get(name);
  }

  async reload(projectDir?: string): Promise<void> {
    this.cache = null;
    await this.base.reload(projectDir);
  }

  /** How many ephemerals exist in this conversation. */
  ephemeralCount(): number {
    return this.ensureCache().size;
  }

  /**
   * Insert a new ephemeral agent. Throws when the name is already claimed —
   * either by the base registry (precedence protects builtins from shadowing)
   * or by another ephemeral in this conversation.
   */
  create(spec: EphemeralAgentSpec): AgentDef {
    if (this.base.get(spec.name) !== undefined) {
      throw new Error(
        `Cannot spawn @${spec.name}: name already belongs to a registered agent.`,
      );
    }
    if (this.ensureCache().has(spec.name)) {
      throw new Error(
        `Cannot spawn @${spec.name}: an ephemeral by that name already exists in this conversation.`,
      );
    }
    const now = new Date().toISOString();
    const def: AgentDef = {
      name: spec.name,
      description: `Ephemeral agent ${spec.name}`,
      systemPrompt: spec.systemPrompt,
      model: spec.model ?? 'inherit',
      maxDepth: spec.maxDepth ?? 2,
      memory: 'none',
      color: spec.color ?? 'cyan',
      icon: spec.icon ?? '🌀',
      userInvocable: false,
      maxTurns: spec.maxTurns ?? 5,
      timeoutMs: 120_000,
      source: 'project',
      sourcePath: `<ephemeral:${this.conversationId}>`,
      ...(spec.tools !== undefined ? { tools: spec.tools } : {}),
    };
    this.db
      .insert(ephemeralAgents)
      .values({
        id: ulid(),
        conversationId: this.conversationId,
        name: spec.name,
        definitionJson: JSON.stringify({
          description: def.description,
          systemPrompt: def.systemPrompt,
          model: def.model,
          maxDepth: def.maxDepth,
          memory: def.memory,
          color: def.color,
          icon: def.icon,
          userInvocable: def.userInvocable,
          maxTurns: def.maxTurns,
          timeoutMs: def.timeoutMs,
          ...(def.tools !== undefined ? { tools: def.tools } : {}),
        }),
        createdAt: now,
      })
      .run();
    this.ensureCache().set(def.name, def);
    return def;
  }
}
