/**
 * MemoryDef — a durable user-facing fact, preference, identity bit, or goal that
 * the assistant should recall across sessions.
 *
 * Memories are text files (.md + YAML frontmatter), NOT database rows. Discovery
 * mirrors SkillRegistry: two tiers — user-global then project-local — with the
 * later tier overriding earlier on `name` collision. There are no builtins.
 *
 * Writes are EXPLICIT only: slash command (`/remember`, `remember:`), natural-
 * language signal regex (e.g. "from now on", "I prefer"), or a future memories
 * screen for manual edit/pin/delete. No background per-turn LLM extraction —
 * see plans/odysseus-competitive-analysis.md §7 "Additional locked design rules".
 *
 * A memory body, when injected into a chat, is treated as UNTRUSTED context —
 * Wave 2 wires it through lib/promptSecurity.wrapUntrusted before the LLM sees it.
 */

/** Author-declared category. `identity` auto-pins on explicit save. */
export type MemoryCategory = 'identity' | 'preference' | 'fact' | 'project' | 'goal' | 'contact';

/** Where the memory came from. */
export type MemorySource = 'slash' | 'nl-signal' | 'imported' | 'user-edit';

/** Resolution tier. Project wins on name collision with user. */
export type MemoryScope = 'user' | 'project';

export interface MemoryDef {
  /** Unique kebab-case name. Matches frontmatter `name:`. Collisions resolved by tier. */
  name: string;
  /** The durable fact itself, <= 280 chars. This is the load-bearing field for retrieval. */
  description: string;
  /** When true, always injected. Auto-set for `identity` category on explicit save. */
  pinned: boolean;
  /** Author-declared category — drives auto-pin and lets the user filter. */
  category: MemoryCategory;
  /** Trigger that produced this memory. */
  source: MemorySource;
  /** ISO 8601 timestamp when this memory was first saved. */
  createdAt: string;
  /** ISO 8601 timestamp when this memory was last injected into a chat. Optional. */
  lastUsed?: string;
  /** Optional longer prose body — captured user message, related history. */
  body?: string;
  /** Filesystem path the memory was loaded from. */
  sourcePath: string;
  /** Tier this memory came from. */
  scope: MemoryScope;
}

export interface IMemoryRegistry {
  list(): MemoryDef[];
  get(name: string): MemoryDef | undefined;
  reload(projectDir?: string): Promise<void>;
}
