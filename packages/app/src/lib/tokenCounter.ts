/**
 * Token counting utilities for session UX surfaces (StatusBar gauge, etc.).
 *
 * Strategy: approximate token count as `chars / 4`. This is fast, deterministic,
 * and matches how OpenAI/Anthropic rough-size prompts in public documentation.
 * It is *not* accurate to the byte — if we need exact accounting we should read
 * `usage.totalTokens` from the AI SDK `step-finish`/`finish` events (which is
 * what `useStream` already does). This helper exists for the pre-submission
 * and fallback paths where no usage payload has been observed yet.
 *
 * Intentionally no tiktoken / js-tiktoken dependency:
 *   - It's ~2MB of WASM at install time.
 *   - It doesn't know about non-OpenAI tokenizers anyway (llama/qwen/gemma all
 *     use different BPE vocabs), so "accurate" is a fiction across providers.
 *   - Chars/4 is within ~15% for English source code, which is fine for a
 *     status-bar gauge whose purpose is "you are approaching the wall."
 */

/** Approximate the number of tokens in a string (chars / 4, rounded up). */
export function approximateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Format a token count as a compact, fixed-width-ish label.
 * Examples: 0 → "0", 812 → "812", 1234 → "1.2k", 128000 → "128k".
 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

/**
 * Render a tiny ASCII gauge bar, e.g. [▓▓▓░░░░░░░].
 * `used` and `total` are raw token counts; `width` is the bar width in cells.
 * When total is 0 or missing, returns an empty string (caller decides whether
 * to render the numeric count alone).
 */
export function renderGaugeBar(used: number, total: number, width = 10): string {
  if (total <= 0 || width <= 0) return '';
  const ratio = Math.max(0, Math.min(1, used / total));
  const filled = Math.round(ratio * width);
  return `[${'▓'.repeat(filled)}${'░'.repeat(width - filled)}]`;
}
