import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_CATALOG } from './data.js';
import type { CatalogEntry, CatalogProviderKind } from './types.js';

export type { CatalogEntry, CatalogCapabilities, CatalogProviderKind } from './types.js';

/** Path where users can drop an override catalog (e.g. LiteLLM export). */
export function getUserCatalogPath(): string {
  return join(homedir(), '.uplnk', 'catalog.json');
}

/**
 * Load the catalog. If `~/.uplnk/catalog.json` exists and parses, its entries
 * are merged over the built-in snapshot (user wins on `canonicalKey` collision).
 *
 * On any error we fall back to the built-in snapshot so the TUI never fails
 * to render because the catalog file is malformed.
 */
export function loadCatalog(): CatalogEntry[] {
  const path = getUserCatalogPath();
  if (!existsSync(path)) return [...BUILTIN_CATALOG];
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...BUILTIN_CATALOG];
    const byKey = new Map<string, CatalogEntry>();
    for (const entry of BUILTIN_CATALOG) byKey.set(entry.canonicalKey, entry);
    for (const entry of parsed as CatalogEntry[]) {
      if (typeof entry?.canonicalKey === 'string') {
        byKey.set(entry.canonicalKey, entry);
      }
    }
    return Array.from(byKey.values());
  } catch {
    return [...BUILTIN_CATALOG];
  }
}

/** Filter catalog entries to a single provider kind. */
export function catalogForKind(
  catalog: CatalogEntry[],
  kind: CatalogProviderKind,
): CatalogEntry[] {
  return catalog.filter((e) => e.kind === kind);
}
