/**
 * Zod schema + parser for memory .md frontmatter.
 * Used by MemoryRegistry to validate files at load time.
 *
 * Mirrors packages/app/src/lib/skills/validate.ts shape — see comments there
 * for the rationale on schema + gray-matter splitting. Memory adds a
 * `metadata:` nested object so the human-edited fields (pinned, category,
 * createdAt, lastUsed, source) group together visually in the file.
 */

import { z } from 'zod';
import matter from 'gray-matter';
import type { MemoryDef, MemoryScope } from './types.js';

const MEMORY_CATEGORY = ['identity', 'preference', 'fact', 'project', 'goal', 'contact'] as const;
const MEMORY_SOURCE = ['slash', 'nl-signal', 'imported', 'user-edit'] as const;

/**
 * gray-matter eagerly converts ISO-8601 date strings in YAML to JS Date instances.
 * Accept both shapes and normalize to a string for the rest of the pipeline.
 */
const IsoDate = z.union([z.string().min(1), z.date()]).transform((v) => {
  if (v instanceof Date) return v.toISOString();
  return v;
});

const MetadataSchema = z.object({
  pinned: z.boolean().default(false),
  category: z.enum(MEMORY_CATEGORY).default('fact'),
  source: z.enum(MEMORY_SOURCE).default('user-edit'),
  createdAt: IsoDate,
  lastUsed: IsoDate.optional(),
});

const MemoryFrontmatterSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'name must be kebab-case'),
  description: z.string().min(1, 'description is required').max(280, 'description must be <= 280 chars'),
  metadata: MetadataSchema,
});

export function parseMemoryFile(raw: string, sourcePath: string, scope: MemoryScope): MemoryDef {
  const parsed = matter(raw);
  const fm = MemoryFrontmatterSchema.parse(parsed.data);
  const body = (parsed.content ?? '').trim();

  const def: MemoryDef = {
    name: fm.name,
    description: fm.description,
    pinned: fm.metadata.pinned,
    category: fm.metadata.category,
    source: fm.metadata.source,
    createdAt: fm.metadata.createdAt,
    sourcePath,
    scope,
  };
  if (fm.metadata.lastUsed !== undefined) def.lastUsed = fm.metadata.lastUsed;
  if (body.length > 0) def.body = body;
  return def;
}

/** Serialize a MemoryDef back to the on-disk format. Inverse of parseMemoryFile. */
export function serializeMemoryFile(def: MemoryDef): string {
  const metadata: Record<string, unknown> = {
    pinned: def.pinned,
    category: def.category,
    source: def.source,
    createdAt: def.createdAt,
  };
  if (def.lastUsed !== undefined) metadata.lastUsed = def.lastUsed;

  // Hand-formatted YAML — gray-matter's stringify pulls in js-yaml; keep zero new deps.
  const fmLines: string[] = [
    '---',
    `name: ${def.name}`,
    `description: ${yamlString(def.description)}`,
    'metadata:',
    `  pinned: ${metadata.pinned as boolean}`,
    `  category: ${metadata.category as string}`,
    `  source: ${metadata.source as string}`,
    `  createdAt: ${metadata.createdAt as string}`,
  ];
  if (def.lastUsed !== undefined) fmLines.push(`  lastUsed: ${def.lastUsed}`);
  fmLines.push('---', '');

  const bodyPart = def.body !== undefined && def.body.length > 0 ? `\n${def.body}\n` : '';
  return fmLines.join('\n') + bodyPart;
}

/**
 * Minimal YAML scalar quoting. Description fields can contain colons, quotes,
 * leading dashes, etc. — always wrap in double quotes and escape backslashes
 * and embedded double-quotes. Safe round-trip.
 */
function yamlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
