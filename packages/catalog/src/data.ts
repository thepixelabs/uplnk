import type { CatalogEntry } from './types.js';

/**
 * Vendored snapshot of widely-used models across major providers.
 *
 * Pricing is in USD per 1M tokens. Numbers track publicly-documented rates
 * as of 2025-Q2 and are intentionally coarse — Pylon uses them for
 * display and rough cost estimation, not billing.
 *
 * Shape is modelled on LiteLLM's `model_prices_and_context_window.json`;
 * users who want a full catalog can drop a fresh copy into
 * `~/.pylon/catalog.json` and Pylon will merge it over this snapshot.
 */
export const BUILTIN_CATALOG: readonly CatalogEntry[] = [
  // ── Ollama — most-pulled models ────────────────────────────────────────
  { canonicalKey: 'ollama/llama3.3',           displayId: 'llama3.3',           kind: 'ollama', family: 'llama', contextWindow: 128_000, capabilities: { tools: true } },
  { canonicalKey: 'ollama/llama3.2',           displayId: 'llama3.2',           kind: 'ollama', family: 'llama', contextWindow: 128_000, capabilities: { tools: true } },
  { canonicalKey: 'ollama/llama3.1',           displayId: 'llama3.1',           kind: 'ollama', family: 'llama', contextWindow: 128_000, capabilities: { tools: true } },
  { canonicalKey: 'ollama/llama3',             displayId: 'llama3',             kind: 'ollama', family: 'llama', contextWindow:   8_000 },
  { canonicalKey: 'ollama/qwen3',              displayId: 'qwen3',              kind: 'ollama', family: 'qwen',  contextWindow:  32_000, capabilities: { tools: true } },
  { canonicalKey: 'ollama/qwen2.5',            displayId: 'qwen2.5',            kind: 'ollama', family: 'qwen',  contextWindow:  32_000, capabilities: { tools: true } },
  { canonicalKey: 'ollama/qwen2.5-coder',      displayId: 'qwen2.5-coder',      kind: 'ollama', family: 'qwen',  contextWindow:  32_000, capabilities: { tools: true } },
  { canonicalKey: 'ollama/deepseek-r1',        displayId: 'deepseek-r1',        kind: 'ollama', family: 'deepseek', contextWindow: 64_000 },
  { canonicalKey: 'ollama/deepseek-coder-v2',  displayId: 'deepseek-coder-v2',  kind: 'ollama', family: 'deepseek', contextWindow: 163_000, capabilities: { tools: true } },
  { canonicalKey: 'ollama/mistral',            displayId: 'mistral',            kind: 'ollama', family: 'mistral', contextWindow:  32_000, capabilities: { tools: true } },
  { canonicalKey: 'ollama/mistral-nemo',       displayId: 'mistral-nemo',       kind: 'ollama', family: 'mistral', contextWindow: 128_000 },
  { canonicalKey: 'ollama/mixtral',            displayId: 'mixtral',            kind: 'ollama', family: 'mistral', contextWindow:  32_000 },
  { canonicalKey: 'ollama/gemma3',             displayId: 'gemma3',             kind: 'ollama', family: 'gemma',   contextWindow: 128_000, capabilities: { vision: true } },
  { canonicalKey: 'ollama/gemma2',             displayId: 'gemma2',             kind: 'ollama', family: 'gemma',   contextWindow:   8_000 },
  { canonicalKey: 'ollama/phi4',               displayId: 'phi4',               kind: 'ollama', family: 'phi',     contextWindow:  16_000 },
  { canonicalKey: 'ollama/phi3',               displayId: 'phi3',               kind: 'ollama', family: 'phi',     contextWindow: 128_000 },
  { canonicalKey: 'ollama/codellama',          displayId: 'codellama',          kind: 'ollama', family: 'llama',   contextWindow:  16_000 },
  { canonicalKey: 'ollama/codegemma',          displayId: 'codegemma',          kind: 'ollama', family: 'gemma',   contextWindow:   8_000 },
  { canonicalKey: 'ollama/starcoder2',         displayId: 'starcoder2',         kind: 'ollama', family: 'starcoder', contextWindow: 16_000 },
  { canonicalKey: 'ollama/nomic-embed-text',   displayId: 'nomic-embed-text',   kind: 'ollama', family: 'nomic' },
  { canonicalKey: 'ollama/llava',              displayId: 'llava',              kind: 'ollama', family: 'llava',   contextWindow:   4_000, capabilities: { vision: true } },

  // ── OpenAI ─────────────────────────────────────────────────────────────
  { canonicalKey: 'openai/gpt-4o',             displayId: 'gpt-4o',             kind: 'openai', family: 'gpt-4',    contextWindow: 128_000, maxOutputTokens: 16_384, inputCostPer1M:  2.50, outputCostPer1M: 10.00, capabilities: { tools: true, vision: true, streaming: true } },
  { canonicalKey: 'openai/gpt-4o-mini',        displayId: 'gpt-4o-mini',        kind: 'openai', family: 'gpt-4',    contextWindow: 128_000, maxOutputTokens: 16_384, inputCostPer1M:  0.15, outputCostPer1M:  0.60, capabilities: { tools: true, vision: true, streaming: true } },
  { canonicalKey: 'openai/gpt-4.1',            displayId: 'gpt-4.1',            kind: 'openai', family: 'gpt-4',    contextWindow: 1_047_576, maxOutputTokens: 32_768, inputCostPer1M: 2.00, outputCostPer1M:  8.00, capabilities: { tools: true, vision: true, streaming: true } },
  { canonicalKey: 'openai/gpt-4.1-mini',       displayId: 'gpt-4.1-mini',       kind: 'openai', family: 'gpt-4',    contextWindow: 1_047_576, maxOutputTokens: 32_768, inputCostPer1M: 0.40, outputCostPer1M:  1.60, capabilities: { tools: true, vision: true, streaming: true } },
  { canonicalKey: 'openai/gpt-4-turbo',        displayId: 'gpt-4-turbo',        kind: 'openai', family: 'gpt-4',    contextWindow: 128_000, maxOutputTokens:  4_096, inputCostPer1M: 10.00, outputCostPer1M: 30.00, capabilities: { tools: true, vision: true, streaming: true } },
  { canonicalKey: 'openai/o1',                 displayId: 'o1',                 kind: 'openai', family: 'o-series', contextWindow: 200_000, maxOutputTokens: 100_000, inputCostPer1M: 15.00, outputCostPer1M: 60.00 },
  { canonicalKey: 'openai/o1-mini',            displayId: 'o1-mini',            kind: 'openai', family: 'o-series', contextWindow: 128_000, maxOutputTokens:  65_536, inputCostPer1M:  3.00, outputCostPer1M: 12.00 },
  { canonicalKey: 'openai/o3',                 displayId: 'o3',                 kind: 'openai', family: 'o-series', contextWindow: 200_000, maxOutputTokens: 100_000, inputCostPer1M: 10.00, outputCostPer1M: 40.00 },
  { canonicalKey: 'openai/o3-mini',            displayId: 'o3-mini',            kind: 'openai', family: 'o-series', contextWindow: 200_000, maxOutputTokens: 100_000, inputCostPer1M:  1.10, outputCostPer1M:  4.40 },

  // ── Anthropic ──────────────────────────────────────────────────────────
  { canonicalKey: 'anthropic/claude-opus-4-6',      displayId: 'claude-opus-4-6',      kind: 'anthropic', family: 'claude-4', contextWindow: 1_000_000, maxOutputTokens: 32_000, inputCostPer1M: 15.00, outputCostPer1M: 75.00, capabilities: { tools: true, vision: true, streaming: true, promptCaching: true } },
  { canonicalKey: 'anthropic/claude-sonnet-4-6',    displayId: 'claude-sonnet-4-6',    kind: 'anthropic', family: 'claude-4', contextWindow:   200_000, maxOutputTokens: 64_000, inputCostPer1M:  3.00, outputCostPer1M: 15.00, capabilities: { tools: true, vision: true, streaming: true, promptCaching: true } },
  { canonicalKey: 'anthropic/claude-sonnet-4-5',    displayId: 'claude-sonnet-4-5',    kind: 'anthropic', family: 'claude-4', contextWindow:   200_000, maxOutputTokens: 64_000, inputCostPer1M:  3.00, outputCostPer1M: 15.00, capabilities: { tools: true, vision: true, streaming: true, promptCaching: true } },
  { canonicalKey: 'anthropic/claude-haiku-4-5',     displayId: 'claude-haiku-4-5',     kind: 'anthropic', family: 'claude-4', contextWindow:   200_000, maxOutputTokens:  8_192, inputCostPer1M:  1.00, outputCostPer1M:  5.00, capabilities: { tools: true, vision: true, streaming: true, promptCaching: true } },
  { canonicalKey: 'anthropic/claude-3-5-sonnet',    displayId: 'claude-3-5-sonnet',    kind: 'anthropic', family: 'claude-3', contextWindow:   200_000, maxOutputTokens:  8_192, inputCostPer1M:  3.00, outputCostPer1M: 15.00, capabilities: { tools: true, vision: true, streaming: true, promptCaching: true } },
  { canonicalKey: 'anthropic/claude-3-5-haiku',     displayId: 'claude-3-5-haiku',     kind: 'anthropic', family: 'claude-3', contextWindow:   200_000, maxOutputTokens:  8_192, inputCostPer1M:  0.80, outputCostPer1M:  4.00, capabilities: { tools: true, streaming: true, promptCaching: true } },
];
