/**
 * Zod schema + parser for skill .md frontmatter.
 * Used by SkillRegistry to validate files at load time.
 *
 * Mirrors packages/app/src/lib/agents/validate.ts shape — see comments there
 * for the rationale on schema + gray-matter splitting.
 */

import { z } from 'zod';
import matter from 'gray-matter';
import type { SkillDef } from './types.js';

const SkillFrontmatterSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'name must be kebab-case'),
  description: z.string().min(1, 'description is required'),
  tags: z.array(z.string()).optional(),
  category: z.string().optional(),
  confidence: z.number().min(0).max(1).default(1.0),
  status: z.enum(['draft', 'published']).default('published'),
});

export function parseSkillFile(
  raw: string,
  sourcePath: string,
  source: 'builtin' | 'user' | 'project' | 'learned',
): SkillDef {
  const parsed = matter(raw);
  const fm = SkillFrontmatterSchema.parse(parsed.data);
  const body = (parsed.content ?? '').trim();

  return {
    name: fm.name,
    description: fm.description,
    ...(fm.tags !== undefined ? { tags: fm.tags } : {}),
    ...(fm.category !== undefined ? { category: fm.category } : {}),
    confidence: fm.confidence,
    status: fm.status,
    source,
    sourcePath,
    body,
  };
}
