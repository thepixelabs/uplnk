import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_CATALOG } from './data.js';
import type { CatalogCapabilities, CatalogEntry, CatalogProviderKind } from './types.js';

export type { CatalogEntry, CatalogCapabilities, CatalogProviderKind } from './types.js';

/**
 * Resolved capability flags. Every field is a concrete boolean — an unknown
 * model gets conservative defaults so callers never wake up with a `undefined`
 * they forgot to handle. Callers should treat `tools: false` as "do not send
 * the `tools` parameter" to avoid models hallucinating tool-call JSON into the
 * text channel (see useStream).
 */
export interface ResolvedCapabilities {
  tools: boolean;
  vision: boolean;
  streaming: boolean;
  promptCaching: boolean;
}

const DEFAULT_CAPABILITIES: ResolvedCapabilities = {
  tools: false,
  vision: false,
  streaming: true,
  promptCaching: false,
};

function materialize(caps: CatalogCapabilities | undefined): ResolvedCapabilities {
  if (!caps) return { ...DEFAULT_CAPABILITIES };
  return {
    tools: caps.tools ?? false,
    vision: caps.vision ?? false,
    streaming: caps.streaming ?? true,
    promptCaching: caps.promptCaching ?? false,
  };
}

/**
 * Resolve a model's capabilities from the catalog. Tries, in order:
 *   1. canonical key "<kind>/<id>"
 *   2. displayId within the given kind
 *   3. displayId across any kind (fallback for providers whose kind the caller
 *      guessed wrong, e.g. custom-wrapped Anthropic)
 * Returns `DEFAULT_CAPABILITIES` (all conservative) if nothing matches.
 *
 * Accepts an optional `catalog` override so callers who already loaded the
 * user catalog don't pay the I/O twice.
 */
export function resolveCapabilities(
  providerKind: CatalogProviderKind,
  modelId: string,
  catalog?: CatalogEntry[],
): ResolvedCapabilities {
  const entries = catalog ?? BUILTIN_CATALOG;
  const canonical = `${providerKind}/${modelId}`;
  const byCanonical = entries.find((e) => e.canonicalKey === canonical);
  if (byCanonical) return materialize(byCanonical.capabilities);
  const byKindAndDisplay = entries.find(
    (e) => e.kind === providerKind && e.displayId === modelId,
  );
  if (byKindAndDisplay) return materialize(byKindAndDisplay.capabilities);
  const byDisplay = entries.find((e) => e.displayId === modelId);
  if (byDisplay) return materialize(byDisplay.capabilities);
  return { ...DEFAULT_CAPABILITIES };
}

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
