/**
 * contextBudget — adaptive per-call trim of a CoreMessage[] history to fit
 * inside a model's input window.
 *
 * Why: cloud models give 128k, vLLM gives 32k, a 4-bit local Qwen on llama.cpp
 * gives 4k. The same conversation is fine in one and a silent 400 / OOM in
 * another. uplnk now probes `Model.contextWindow` live (Phase A item 1.6),
 * but the SDK has no built-in trimmer — providers either truncate opaquely,
 * 400 with a vague error, or run the model into degraded output. This module
 * makes the trim explicit, deterministic, and testable.
 *
 * Algorithm (priority-ordered, see plan §4 Tier 1 row 1.4):
 *   1. Compute the input budget. `reserveForOutput` wins; otherwise
 *      `contextWindow * inputBudgetRatio` (default 0.85). Floor to int.
 *   2. If the sum of all message token estimates already fits, return the
 *      input unchanged with `trimmed: false`.
 *   3. Drop messages from the OLDEST end. Never drop:
 *      - messages in `protectedIndices` (the caller's "must keep" set),
 *      - the last `protectRecent` messages (default 10),
 *      - the last user message.
 *   4. If still over budget, head/tail truncate the largest droppable
 *      candidate (keep ~30% head + ~30% tail with a visible notice).
 *      Repeat until budget met or only protected/recent remain.
 *   5. If a protected or last-user message is itself larger than the
 *      budget, head/tail truncate IT too (we never lose the last user
 *      turn — only its middle).
 *   6. If we still cannot fit (irreducible set sums above budget), return
 *      the irreducible set with a notice at index 0.
 *
 * Token estimation uses `tokenCounter.approximateTokens` (chars/4). Cached
 * per-call inside `trimMessagesForContext` keyed on object identity so the
 * iterative dropper does not re-estimate the same message O(n) times.
 *
 * Pure module: inputs are `readonly`, no message is mutated, no module-level
 * state. Composes after `sanitizeMessages` + `stripReasoningContent`.
 */

import type { CoreMessage } from 'ai';
import { approximateTokens } from './tokenCounter.js';

export interface TrimOptions {
  /** Model's full context window in tokens. */
  contextWindow: number;
  /** Fraction of contextWindow available for the INPUT (the rest goes to completion). Default 0.85. */
  inputBudgetRatio?: number;
  /** Reserve N tokens for the model's response. If set, overrides the ratio for that calculation. */
  reserveForOutput?: number;
  /** Protect the most recent N MESSAGES from being dropped (default 10). */
  protectRecent?: number;
  /** Indices of messages in the input array that MUST NOT be dropped (e.g., active doc, RAG preamble). */
  protectedIndices?: readonly number[];
  /** If a single message exceeds `inputBudget`, head/tail truncate it with a visible notice. Default true. */
  truncateOversizedMessages?: boolean;
}

export interface TrimResult {
  /** Possibly-shorter message array. Same shape per message; deletions only. */
  messages: CoreMessage[];
  /** Whether any messages were dropped. */
  trimmed: boolean;
  /** Count of dropped messages (excluding truncation). */
  droppedCount: number;
  /** Per-message truncation notices: index in the OUTPUT array → notice text. */
  truncations: Record<number, string>;
  /** Final estimated input tokens after trimming. */
  estimatedInputTokens: number;
  /** Final budget the trim worked against. */
  inputBudget: number;
}

const DEFAULT_INPUT_BUDGET_RATIO = 0.85;
const DEFAULT_PROTECT_RECENT = 10;
const HEAD_TAIL_KEEP_RATIO = 0.3;
const TRUNCATION_ELLIPSIS = '\n\n[...uplnk-trimmed: %BYTES% bytes elided to fit context budget...]\n\n';

/** Compute input token budget from contextWindow + opts. Pure, exposed for tests. */
export function computeInputBudget(opts: TrimOptions): number {
  const { contextWindow, reserveForOutput, inputBudgetRatio } = opts;
  if (typeof reserveForOutput === 'number') {
    return Math.max(0, Math.floor(contextWindow - reserveForOutput));
  }
  const ratio = inputBudgetRatio ?? DEFAULT_INPUT_BUDGET_RATIO;
  return Math.max(0, Math.floor(contextWindow * ratio));
}

/**
 * Estimate tokens for a single CoreMessage. Sums all text-bearing fields.
 *
 * Coverage:
 *   - string content → approximateTokens of the string
 *   - array content → sum of approximateTokens over each part's textual
 *     payload (text / reasoning / tool-call args / tool-result result)
 *   - undefined / null content → 0
 */
export function estimateMessageTokens(msg: CoreMessage): number {
  const content = (msg as { content?: unknown }).content;
  if (content === undefined || content === null) return 0;
  if (typeof content === 'string') return approximateTokens(content);
  if (!Array.isArray(content)) return 0;

  let total = 0;
  for (const part of content) {
    total += estimatePartTokens(part);
  }
  return total;
}

function estimatePartTokens(part: unknown): number {
  if (typeof part !== 'object' || part === null) return 0;
  const p = part as {
    type?: string;
    text?: unknown;
    data?: unknown;
    args?: unknown;
    result?: unknown;
    toolName?: unknown;
  };
  let n = 0;
  if (typeof p.text === 'string') n += approximateTokens(p.text);
  if (typeof p.data === 'string') n += approximateTokens(p.data);
  if (typeof p.toolName === 'string') n += approximateTokens(p.toolName);
  if (p.args !== undefined) n += approximateTokens(safeStringify(p.args));
  if (p.result !== undefined) n += approximateTokens(safeStringify(p.result));
  return n;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

interface IndexedMessage {
  /** Stable position in the ORIGINAL input array, used for protectedIndices lookup. */
  origIndex: number;
  msg: CoreMessage;
  tokens: number;
}

/**
 * Drop oldest first, respecting protected + protectRecent + last-user
 * invariants. Returns the surviving messages in their original order.
 */
function dropOldestUntilFits(
  indexed: IndexedMessage[],
  budget: number,
  protectedSet: ReadonlySet<number>,
  protectRecentCount: number,
  lastUserOrigIndex: number,
): { survivors: IndexedMessage[]; droppedCount: number; total: number } {
  // Build a working copy and a "droppable" mask. Recent-N is by ORIGINAL
  // input position (so protectRecent is measured against the unfiltered
  // history, not whatever survives), per spec.
  const n = indexed.length;
  if (n === 0) {
    return { survivors: [], droppedCount: 0, total: 0 };
  }

  // The "last N messages" in the input are those at positions [n - protectRecentCount, n).
  // Original indices in `indexed` are increasing but not necessarily contiguous
  // because callers can pass any messages; we treat the LAST protectRecentCount
  // ENTRIES of `indexed` as recent (they correspond to the most recent input
  // positions when `indexed` mirrors the input array).
  const recentSet = new Set<number>();
  for (let i = Math.max(0, n - protectRecentCount); i < n; i++) {
    recentSet.add(indexed[i]!.origIndex);
  }

  const isDroppable = (entry: IndexedMessage): boolean => {
    if (protectedSet.has(entry.origIndex)) return false;
    if (recentSet.has(entry.origIndex)) return false;
    if (entry.origIndex === lastUserOrigIndex) return false;
    return true;
  };

  let total = indexed.reduce((acc, e) => acc + e.tokens, 0);
  if (total <= budget) {
    return { survivors: indexed.slice(), droppedCount: 0, total };
  }

  const survivors = indexed.slice();
  let droppedCount = 0;

  // Walk oldest → newest, drop droppable entries until under budget.
  for (let i = 0; i < survivors.length && total > budget; ) {
    const entry = survivors[i]!;
    if (isDroppable(entry)) {
      survivors.splice(i, 1);
      total -= entry.tokens;
      droppedCount += 1;
      // do not advance i (next entry shifted into position)
    } else {
      i += 1;
    }
  }

  return { survivors, droppedCount, total };
}

/**
 * Head/tail truncate a string to roughly 2 * keepRatio of its length, with
 * a visible ellipsis carrying the elided byte count. Returns the truncated
 * string and the notice that should be surfaced to the caller.
 *
 * Guarantees the result is shorter than the input when input length is
 * above a small floor (otherwise returns input unchanged).
 */
function headTailTruncateString(
  text: string,
  keepRatio: number,
): { text: string; notice: string } | null {
  const len = text.length;
  if (len < 200) return null; // not worth truncating
  const keepHead = Math.floor(len * keepRatio);
  const keepTail = Math.floor(len * keepRatio);
  if (keepHead + keepTail >= len) return null;
  const elided = len - keepHead - keepTail;
  const ellipsis = TRUNCATION_ELLIPSIS.replace('%BYTES%', String(elided));
  const truncated = text.slice(0, keepHead) + ellipsis + text.slice(len - keepTail);
  if (truncated.length >= len) return null;
  return {
    text: truncated,
    notice: `truncated: ${elided} bytes elided from middle (head/tail ${Math.round(keepRatio * 100)}%/${Math.round(keepRatio * 100)}%)`,
  };
}

/**
 * Head/tail truncate the textual payload(s) of a CoreMessage. Returns
 * either a new message + notice, or null if the message cannot be
 * meaningfully shrunk further.
 */
function truncateMessage(msg: CoreMessage): { msg: CoreMessage; notice: string } | null {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === 'string') {
    const t = headTailTruncateString(content, HEAD_TAIL_KEEP_RATIO);
    if (t === null) return null;
    return {
      msg: { ...msg, content: t.text } as CoreMessage,
      notice: t.notice,
    };
  }
  if (!Array.isArray(content)) return null;

  // Truncate the largest text-bearing part. Walk once to find it.
  let largestIdx = -1;
  let largestLen = 0;
  for (let i = 0; i < content.length; i++) {
    const part = content[i] as { text?: unknown };
    if (typeof part.text === 'string' && part.text.length > largestLen) {
      largestIdx = i;
      largestLen = part.text.length;
    }
  }
  if (largestIdx < 0) return null;
  const target = content[largestIdx] as { text: string };
  const t = headTailTruncateString(target.text, HEAD_TAIL_KEEP_RATIO);
  if (t === null) return null;
  const nextContent = content.slice();
  nextContent[largestIdx] = { ...(content[largestIdx] as object), text: t.text };
  return {
    msg: { ...msg, content: nextContent } as CoreMessage,
    notice: t.notice,
  };
}

function findLastUserIndex(messages: readonly CoreMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return i;
  }
  return -1;
}

export function trimMessagesForContext(
  messages: readonly CoreMessage[],
  opts: TrimOptions,
): TrimResult {
  const inputBudget = computeInputBudget(opts);
  const protectRecent = opts.protectRecent ?? DEFAULT_PROTECT_RECENT;
  const protectedSet: ReadonlySet<number> = new Set(opts.protectedIndices ?? []);
  const truncateOversized = opts.truncateOversizedMessages ?? true;
  const lastUserOrigIndex = findLastUserIndex(messages);

  if (messages.length === 0) {
    return {
      messages: [],
      trimmed: false,
      droppedCount: 0,
      truncations: {},
      estimatedInputTokens: 0,
      inputBudget,
    };
  }

  // One-shot token estimation: cache the per-message estimate so the dropper
  // and the truncator do not re-walk the same strings repeatedly.
  const indexed: IndexedMessage[] = messages.map((msg, origIndex) => ({
    origIndex,
    msg,
    tokens: estimateMessageTokens(msg),
  }));

  const totalEstimated = indexed.reduce((acc, e) => acc + e.tokens, 0);

  // Fast path: already fits.
  if (totalEstimated <= inputBudget) {
    return {
      messages: messages.slice(),
      trimmed: false,
      droppedCount: 0,
      truncations: {},
      estimatedInputTokens: totalEstimated,
      inputBudget,
    };
  }

  // Step 1: drop oldest droppable until fits or only protected/recent remain.
  const { survivors, droppedCount: drops1, total: totalAfterDrops } = dropOldestUntilFits(
    indexed,
    inputBudget,
    protectedSet,
    protectRecent,
    lastUserOrigIndex,
  );

  let working = survivors;
  let total = totalAfterDrops;
  let droppedCount = drops1;
  const truncations: Record<number, string> = {};

  // Step 2: still over budget → truncate oversized non-protected non-recent
  // messages, then if needed truncate the protected/recent messages too.
  if (total > inputBudget && truncateOversized) {
    // Try non-protected/non-recent first.
    const recentSet = new Set<number>();
    const survivorsCount = working.length;
    for (let i = Math.max(0, survivorsCount - protectRecent); i < survivorsCount; i++) {
      recentSet.add(working[i]!.origIndex);
    }

    // Iterate: find the largest droppable-ish message, truncate it, recompute.
    let safety = working.length * 2;
    while (total > inputBudget && safety-- > 0) {
      // Find largest message (excluding the last user message which we handle
      // last so it gets truncated only if absolutely necessary).
      let largestIdx = -1;
      let largestTokens = 0;
      for (let i = 0; i < working.length; i++) {
        const entry = working[i]!;
        if (entry.origIndex === lastUserOrigIndex) continue;
        if (entry.tokens > largestTokens) {
          largestIdx = i;
          largestTokens = entry.tokens;
        }
      }
      if (largestIdx < 0) break;
      const entry = working[largestIdx]!;
      const truncated = truncateMessage(entry.msg);
      if (truncated === null) {
        // Cannot shrink further — bail to the last-user truncation pass.
        break;
      }
      const newTokens = estimateMessageTokens(truncated.msg);
      total += newTokens - entry.tokens;
      working = working.slice();
      working[largestIdx] = { origIndex: entry.origIndex, msg: truncated.msg, tokens: newTokens };
      truncations[largestIdx] = truncated.notice;
    }

    // Last resort: truncate the last user message itself.
    if (total > inputBudget) {
      const lastUserPos = working.findIndex((e) => e.origIndex === lastUserOrigIndex);
      if (lastUserPos >= 0) {
        const entry = working[lastUserPos]!;
        const truncated = truncateMessage(entry.msg);
        if (truncated !== null) {
          const newTokens = estimateMessageTokens(truncated.msg);
          total += newTokens - entry.tokens;
          working = working.slice();
          working[lastUserPos] = { origIndex: entry.origIndex, msg: truncated.msg, tokens: newTokens };
          truncations[lastUserPos] = truncated.notice;
        }
      }
    }
  }

  // Step 3: still over budget after everything → surface a top-of-output notice.
  if (total > inputBudget) {
    const overBy = total - inputBudget;
    const existing = truncations[0];
    const note = `input still exceeds budget by ${overBy} tokens`;
    truncations[0] = existing === undefined ? note : `${existing}; ${note}`;
  }

  return {
    messages: working.map((e) => e.msg),
    trimmed: droppedCount > 0 || Object.keys(truncations).length > 0,
    droppedCount,
    truncations,
    estimatedInputTokens: total,
    inputBudget,
  };
}
