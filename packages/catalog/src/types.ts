/**
 * Provider kind, duplicated here (not imported from pylon-providers) so the
 * catalog package has no dependency on the providers package. Strings are
 * kept in sync with `ProviderKind` in `pylon-providers`.
 */
export type CatalogProviderKind =
  | 'ollama'
  | 'openai-compatible'
  | 'lmstudio'
  | 'vllm'
  | 'localai'
  | 'llama-cpp'
  | 'anthropic'
  | 'openai'
  | 'custom';

export interface CatalogCapabilities {
  tools?: boolean;
  vision?: boolean;
  streaming?: boolean;
  promptCaching?: boolean;
}

/**
 * A single entry in the static catalog. `canonicalKey` is the untagged form
 * used for matching against discovered models ("ollama/llama3.2"), while
 * `displayId` is the value the user actually sees and uses in chat calls.
 */
export interface CatalogEntry {
  canonicalKey: string;
  displayId: string;
  displayName?: string;
  kind: CatalogProviderKind;
  family?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  capabilities?: CatalogCapabilities;
}
