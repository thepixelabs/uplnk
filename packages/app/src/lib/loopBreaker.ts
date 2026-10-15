/**
 * loopBreaker — detect when an agent is wedged on the same tool call and force
 * a tool-free synthesis round before hitting the SDK's hard step cap.
 *
 * Background. The Vercel AI SDK exposes `maxSteps` as the only "stop the
 * agent" lever. When a small / quantized model loops the same `web_search`
 * call four times in a row, the SDK silently consumes those steps and then
 * throws. The user sees an error with no salvageable answer.
 *
 * Odysseus's `agent_loop.py` solves this with a rolling-window detector:
 * keep the last N tool-call signatures (toolName + hashed args), and after
 * each step ask two questions —
 *
 *   1. Has the same signature repeated K times in a row?
 *   2. Has the same TOOL (any args) been called M times this turn?
 *
 * If either is true, inject a "stop and answer" system message and drop tool
 * schemas on the next call, forcing the model to commit to a synthesis.
 *
 * Scope of this module. We own the detector and the verdict. The wire-up to
 * `streamText`'s `onStepFinish` callback (which is where the verdict flows
 * back into the agent loop) is a Wave 2 concern — kept separate so the
 * detector stays a pure, isolated state machine that's trivial to unit-test.
 *
 * Conventions.
 *   - `observe(sig)` MUST be called exactly once per tool-call event.
 *   - One `LoopBreaker` instance per agent invocation. Do not share across
 *     invocations; do not reuse across user turns (call `reset()`).
 *   - `force-error` is reserved for a future hard-fail policy (e.g. "abort
 *     after N tool errors"). `observe()` never returns it today; the variant
 *     exists in the verdict union so callers can switch exhaustively now.
 */

import { createHash } from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** Stable identity of a tool call: tool name plus hashed args. */
export interface ToolCallSignature {
  toolName: string;
  /** Stable hash of the tool args. Same args → same hash. */
  argsHash: string;
}

/** Verdict returned by `LoopBreaker.observe()`. */
export type LoopBreakerVerdict =
  | { action: 'continue' }
  | { action: 'force-answer'; reason: string }
  | { action: 'force-error'; reason: string };

/** Tunables. Defaults match Odysseus's published loop-breaker. */
export interface LoopBreakerOptions {
  /** N consecutive identical signatures → force-answer. Default 4. */
  stuckRoundThreshold?: number;
  /** Total calls to the same tool (regardless of args) in this loop → force-answer. Default 15. */
  sameToolCallLimit?: number;
  /** History window size — only the last N signatures are remembered. Default 6. */
  signatureWindow?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_STUCK_THRESHOLD = 4;
const DEFAULT_SAME_TOOL_LIMIT = 15;
const DEFAULT_WINDOW = 6;

// ─────────────────────────────────────────────────────────────────────────────
// Hashing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic JSON serialization with recursively sorted object keys.
 *
 * Behavior on non-JSON inputs (defensive — tool args should not contain these,
 * but we'd rather throw a clear error than emit a silent wrong hash):
 *   - functions / symbols / bigints → TypeError
 *   - circular references           → propagates JSON.stringify's TypeError
 *   - undefined (top level or inside an object)
 *                                   → encoded as the literal token "__undefined__"
 *     (JSON cannot represent undefined; we treat it explicitly so observe()
 *     can distinguish `{x: undefined}` from `{}`).
 */
function stableSerialize(value: unknown): string {
  return serializeNode(value);
}

function serializeNode(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number' || t === 'boolean') return JSON.stringify(value);
  if (t === 'function' || t === 'symbol' || t === 'bigint') {
    throw new TypeError(`hashToolArgs: unsupported value of type ${t}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => serializeNode(v)).join(',')}]`;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      parts.push(`${JSON.stringify(k)}:${serializeNode(obj[k])}`);
    }
    return `{${parts.join(',')}}`;
  }
  // Unknown / host-defined types — defensive fallback.
  throw new TypeError(`hashToolArgs: unsupported value of type ${t}`);
}

/** Pure: stable SHA-256 hex of a deterministic serialization of `args`. */
export function hashToolArgs(args: unknown): string {
  const serialized = stableSerialize(args);
  return createHash('sha256').update(serialized).digest('hex');
}

/** Build a `ToolCallSignature` from a tool name and its args. */
export function makeSignature(toolName: string, args: unknown): ToolCallSignature {
  return { toolName, argsHash: hashToolArgs(args) };
}

// ─────────────────────────────────────────────────────────────────────────────
// LoopBreaker
// ─────────────────────────────────────────────────────────────────────────────

function sigEquals(a: ToolCallSignature, b: ToolCallSignature): boolean {
  return a.toolName === b.toolName && a.argsHash === b.argsHash;
}

/**
 * Stateful loop-breaker. One instance per agent invocation; reset between
 * user turns.
 */
export class LoopBreaker {
  private readonly stuckThreshold: number;
  private readonly sameToolLimit: number;
  private readonly window: number;
  private readonly recent: ToolCallSignature[] = [];
  private readonly perToolCount: Map<string, number> = new Map();
  private stuckCount = 0;

  constructor(opts: LoopBreakerOptions = {}) {
    this.stuckThreshold = opts.stuckRoundThreshold ?? DEFAULT_STUCK_THRESHOLD;
    this.sameToolLimit = opts.sameToolCallLimit ?? DEFAULT_SAME_TOOL_LIMIT;
    this.window = opts.signatureWindow ?? DEFAULT_WINDOW;
  }

  /**
   * Record one tool-call signature and return the policy verdict.
   *
   * Stuck-run check fires first (it can hit at signature count = 4 with the
   * defaults, well before the same-tool ceiling at 15). Same-tool check fires
   * when the model is diversifying its args but still hammering one tool.
   */
  observe(sig: ToolCallSignature): LoopBreakerVerdict {
    // Push into the rolling window.
    this.recent.push(sig);
    if (this.recent.length > this.window) {
      this.recent.shift();
    }

    // Cumulative per-tool counter (NOT bounded by the window).
    const nextCount = (this.perToolCount.get(sig.toolName) ?? 0) + 1;
    this.perToolCount.set(sig.toolName, nextCount);

    // Recompute trailing-run length of identical signatures.
    this.stuckCount = computeTrailingRun(this.recent);

    if (this.stuckCount >= this.stuckThreshold) {
      return {
        action: 'force-answer',
        reason: `Tool ${sig.toolName} called ${this.stuckCount} times with identical args`,
      };
    }
    if (nextCount >= this.sameToolLimit) {
      return {
        action: 'force-answer',
        reason: `Tool ${sig.toolName} called ${nextCount} times this turn`,
      };
    }
    return { action: 'continue' };
  }

  /** Reset all state. Call between user turns. */
  reset(): void {
    this.recent.length = 0;
    this.perToolCount.clear();
    this.stuckCount = 0;
  }

  /** Read-only snapshot for telemetry / debug rendering. */
  snapshot(): {
    recentSignatures: readonly ToolCallSignature[];
    perToolCallCounts: Readonly<Record<string, number>>;
    stuckCount: number;
  } {
    const counts: Record<string, number> = {};
    for (const [name, n] of this.perToolCount) {
      counts[name] = n;
    }
    return {
      recentSignatures: Object.freeze(this.recent.map((s) => Object.freeze({ ...s }))),
      perToolCallCounts: Object.freeze(counts),
      stuckCount: this.stuckCount,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Intervention — execute-time blocking of repeated identical calls
//
// The detector above observes AFTER a step finishes (emit/log only). The
// wrapper below is the deferred "Wave 2 wire-up" (see the module doc): it
// intercepts BEFORE execution, so the Nth consecutive identical call never
// runs — a synthetic tool result is returned instead, telling the model to
// stop repeating and answer with what it has.
// ─────────────────────────────────────────────────────────────────────────────

/** Consecutive identical calls at which execution is blocked. */
export const LOOP_BREAKER_INTERVENE_THRESHOLD = 3;

/** Synthetic tool result returned in place of a blocked execution. */
export const LOOP_BREAKER_SYNTHETIC_RESULT =
  '[loop-breaker] this exact call already ran twice with the same result; do not repeat it — use what you have and answer.';

export interface LoopBreakerInterventionInfo {
  toolName: string;
  argsHash: string;
  /** How many times in a row this exact call has now been attempted. */
  occurrence: number;
}

export interface WrapToolsOptions {
  /**
   * false → tools are returned UNTOUCHED (preserves the previous emit-only
   * behaviour end to end). Default true.
   */
  intervene?: boolean;
  /** Consecutive identical calls at which the call is blocked. Default 3. */
  threshold?: number;
  /** Invoked on every blocked call (before the synthetic result is returned). */
  onIntervene?: (info: LoopBreakerInterventionInfo) => void;
}

interface ExecutableToolLike {
  execute?: (args: unknown, options: unknown) => unknown;
}

/**
 * Wrap each tool's `execute` with a consecutive-identical-call guard.
 *
 * Semantics:
 *   - The counter is SHARED across all wrapped tools: "in a row" means
 *     consecutive tool calls within the invocation. A call to a different
 *     tool — or the same tool with different args — resets the run to 1.
 *   - Calls 1 and 2 of an identical signature execute normally; call 3 (and
 *     any further identical repeats) are blocked and return
 *     `LOOP_BREAKER_SYNTHETIC_RESULT` without executing.
 *   - Blocked calls still count as occurrences, so a model that keeps
 *     hammering stays blocked until it changes the call.
 *   - Tools without an `execute` (client-side tools) pass through untouched.
 *   - If args cannot be hashed (defensive — see hashToolArgs), the call
 *     executes normally: the guard must never break a legitimate call.
 *
 * One wrapper per agent invocation / chat send — do not share across turns.
 */
export function wrapToolsWithLoopBreaker<T extends Record<string, unknown>>(
  tools: T,
  opts: WrapToolsOptions = {},
): T {
  if (opts.intervene === false) return tools;
  const threshold = opts.threshold ?? LOOP_BREAKER_INTERVENE_THRESHOLD;

  let last: ToolCallSignature | null = null;
  let run = 0;

  const wrapped: Record<string, unknown> = {};
  for (const [name, rawTool] of Object.entries(tools)) {
    const tool = rawTool as ExecutableToolLike;
    if (typeof tool.execute !== 'function') {
      wrapped[name] = rawTool;
      continue;
    }
    const original = tool.execute.bind(tool);
    wrapped[name] = {
      ...tool,
      execute: (args: unknown, options: unknown): unknown => {
        let sig: ToolCallSignature;
        try {
          sig = makeSignature(name, args);
        } catch {
          // Unhashable args — cannot loop-detect; never block a real call.
          return original(args, options);
        }
        if (last !== null && sigEquals(sig, last)) {
          run += 1;
        } else {
          last = sig;
          run = 1;
        }
        if (run >= threshold) {
          opts.onIntervene?.({ toolName: name, argsHash: sig.argsHash, occurrence: run });
          return LOOP_BREAKER_SYNTHETIC_RESULT;
        }
        return original(args, options);
      },
    };
  }
  return wrapped as T;
}

/** Length of the trailing run of identical signatures at the end of `arr`. */
function computeTrailingRun(arr: readonly ToolCallSignature[]): number {
  if (arr.length === 0) return 0;
  const last = arr[arr.length - 1]!;
  let run = 1;
  for (let i = arr.length - 2; i >= 0; i--) {
    if (sigEquals(arr[i]!, last)) {
      run++;
    } else {
      break;
    }
  }
  return run;
}
