import type { Model, ProviderKind } from './types.js';
import type { CatalogEntry } from '@uplnk/catalog';

/**
 * Canonicalize a model id for lookup in the catalog.
 *
 * Ollama reports tagged variants (`llama3.2:3b`, `llama3.2:latest`).
 * Catalog keys use `ollama/llama3.2` — we strip the tag for lookup but
 * preserve the original id for the chat call.
 */
function catalogKey(kind: ProviderKind, id: string): string {
  const prefix = kind === 'ollama' ? 'ollama/' : '';
  const untagged = id.replace(/:[^:]+$/, '');
  return `${prefix}${untagged}`;
}

function enrichFromCatalog(model: Model, entry: CatalogEntry): Model {
  return {
    ...model,
    source: model.source === 'catalog' ? 'catalog' : 'both',
    ...(model.contextWindow === undefined && entry.contextWindow !== undefined
      ? { contextWindow: entry.contextWindow }
      : {}),
    ...(model.maxOutputTokens === undefined && entry.maxOutputTokens !== undefined
      ? { maxOutputTokens: entry.maxOutputTokens }
      : {}),
    ...(model.inputCostPer1M === undefined && entry.inputCostPer1M !== undefined
      ? { inputCostPer1M: entry.inputCostPer1M }
      : {}),
    ...(model.outputCostPer1M === undefined && entry.outputCostPer1M !== undefined
      ? { outputCostPer1M: entry.outputCostPer1M }
      : {}),
    ...(entry.family !== undefined && model.family === undefined
      ? { family: entry.family }
      : {}),
    capabilities: {
      ...(model.capabilities ?? {}),
      ...(entry.capabilities ?? {}),
    },
  };
}

interface MergeResult {
  /** Models the live server actually serves, enriched with catalog metadata. */
  installed: Model[];
  /** Catalog-only entries for this provider kind that the server doesn't serve. */
  available: Model[];
}

/**
 * Merge a live `listModels()` result against the static catalog for the same
 * provider kind. Installed models come first (selectable); available ones are
 * listed beneath (informational — user must pull/enable them externally).
 */
export function mergeWithCatalog(
  kind: ProviderKind,
  discovered: Model[],
  catalog: CatalogEntry[],
): MergeResult {
  const catalogByKey = new Map<string, CatalogEntry>();
  for (const entry of catalog) {
    if (entry.kind !== kind) continue;
    catalogByKey.set(entry.canonicalKey, entry);
  }

  const installed: Model[] = discovered.map((m) => {
    const entry = catalogByKey.get(catalogKey(kind, m.id));
    return entry !== undefined ? enrichFromCatalog(m, entry) : m;
  });

  const installedKeys = new Set(
    discovered.map((m) => catalogKey(kind, m.id)),
  );
  const available: Model[] = [];
  for (const entry of catalog) {
    if (entry.kind !== kind) continue;
    if (installedKeys.has(entry.canonicalKey)) continue;
    available.push({
      id: entry.displayId,
      displayName: entry.displayName ?? entry.displayId,
      kind,
      source: 'catalog',
      ...(entry.family !== undefined ? { family: entry.family } : {}),
      ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
      ...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
      ...(entry.inputCostPer1M !== undefined ? { inputCostPer1M: entry.inputCostPer1M } : {}),
      ...(entry.outputCostPer1M !== undefined ? { outputCostPer1M: entry.outputCostPer1M } : {}),
      ...(entry.capabilities !== undefined ? { capabilities: entry.capabilities } : {}),
    });
  }

  return { installed, available };
}
