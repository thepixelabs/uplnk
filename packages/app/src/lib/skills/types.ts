/**
 * SkillDef — a reusable procedure / SOP / prompt fragment that can be loaded
 * into an agent's system prompt by name.
 *
 * Skills are text files (.md + YAML frontmatter), NOT database rows.
 * Discovery mirrors AgentRegistry: builtins → user-global → project-local,
 * later overrides earlier on name collision.
 *
 * A skill body, when injected into a chat, is treated as UNTRUSTED context —
 * wrapped via lib/promptSecurity.wrapUntrusted before reaching the LLM.
 * This keeps user-editable skill content from being mistaken for system
 * instructions and is the same approach used for retrieved file/web text.
 */

export interface SkillDef {
  /** Unique kebab-case name. Matches frontmatter `name:`. Same constraint as AgentDef. */
  name: string;
  /** One-liner used by retrieval/selection. Short — fits in a name+description index. */
  description: string;
  /** Free-form tags for filtering. */
  tags?: string[];
  /** Author-declared category — purely informational. */
  category?: string;
  /** Author-declared confidence 0.0–1.0. Defaults to 1.0 for hand-authored skills. */
  confidence: number;
  /** draft = present but not auto-injected. published = available for injection. */
  status: 'draft' | 'published';
  /** Where this skill came from. */
  source: 'builtin' | 'user' | 'project' | 'learned';
  /** Filesystem path the skill was loaded from. */
  sourcePath: string;
  /** Markdown body (everything after the YAML frontmatter fence). */
  body: string;
}

export interface ISkillRegistry {
  list(): SkillDef[];
  get(name: string): SkillDef | undefined;
  /** Resolve the names requested by an agent into their bodies, skipping unknown / draft. */
  resolve(names: readonly string[]): SkillDef[];
  reload(projectDir?: string): Promise<void>;
}
