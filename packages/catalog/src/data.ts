import type { CatalogEntry } from './types.js';

// Static entries removed. The catalog is fetched from LiteLLM and cached to
// ~/.uplnk/catalog.json on first open of the model selector. Press r to refresh.
export const BUILTIN_CATALOG: readonly CatalogEntry[] = [];
