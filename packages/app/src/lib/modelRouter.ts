/**
 * ModelRouter — pure local task complexity classification and model routing.
 *
 * No API calls are made; all decisions are heuristic-based so latency is O(1).
 * When routing is disabled (the default), `route()` always returns the
 * defaultModel unchanged — zero behavioural difference vs. pre-router code.
 */

export type TaskComplexity = 'simple' | 'moderate' | 'complex';

export interface RoutingResult {
  modelId: string;
  /** Human-readable explanation suitable for an audit log. */
  reason: string;
}

export interface ModelRouterConfig {
  /** When false the router is a no-op and always returns defaultModel. */
  enabled: boolean;
  /** Fallback model used when routing is disabled or no route is defined. */
  defaultModel: string;
  routes: Record<TaskComplexity, string>;
}

// ─── Complexity keywords ───────────────────────────────────────────────────

/**
 * Keywords that, when found in a message, push it into the "complex" tier.
 * The list is intentionally narrow — false positives hurt UX more than
 * false negatives (routing to a weaker model for an easy task is tolerable;
 * routing to a weaker model for a hard task wastes context).
 */
const COMPLEX_KEYWORDS: ReadonlyArray<string> = [
  'refactor',
  'architect',
  'architecture',
  'design',
  'implement',
  'migrate',
  'migration',
  'debug',
];

/**
 * Patterns that indicate a "simple" query regardless of length.
 * Only applied when the message is relatively short.
 */
const SIMPLE_PATTERNS: ReadonlyArray<RegExp> = [
  /^what\s+is\b/i,
  /^show\s+me\b/i,
  /^list\b/i,
  /^define\b/i,
  /^explain\b/i,
];

const COMPLEX_CHAR_THRESHOLD = 300;
const SIMPLE_CHAR_THRESHOLD = 50;
const COMPLEX_TURN_THRESHOLD = 10;

// ─── ModelRouter ──────────────────────────────────────────────────────────

export class ModelRouter {
  constructor(private readonly config: ModelRouterConfig) {}

  /**
   * Classify a user message into a complexity tier using purely local
   * heuristics — no network requests, no LLM calls.
   *
   * Rules (evaluated in order; first match wins):
   *  1. Empty string → simple
   *  2. Length > COMPLEX_CHAR_THRESHOLD → complex
   *  3. Contains a complex keyword → complex
   *  4. Length < SIMPLE_CHAR_THRESHOLD AND matches a simple pattern → simple
   *  5. Length < SIMPLE_CHAR_THRESHOLD AND is a single-word query → simple
   *  6. Default → moderate
   */
  classifyComplexity(message: string): TaskComplexity {
    const trimmed = message.trim();

    // Rule 1 — empty
    if (trimmed.length === 0) {
      return 'simple';
    }

    // Rule 2 — long messages are always complex
    if (trimmed.length > COMPLEX_CHAR_THRESHOLD) {
      return 'complex';
    }

    // Rule 3 — complex keyword match (case-insensitive)
    const lower = trimmed.toLowerCase();
    for (const keyword of COMPLEX_KEYWORDS) {
      // Whole-word match using word boundaries to avoid "architect" matching
      // inside "architecturally" when a narrower check is intended.
      const re = new RegExp(`\\b${keyword}\\b`, 'i');
      if (re.test(lower)) {
        return 'complex';
      }
    }

    // Rules 4 & 5 — short messages
    if (trimmed.length < SIMPLE_CHAR_THRESHOLD) {
      for (const pattern of SIMPLE_PATTERNS) {
        if (pattern.test(trimmed)) {
          return 'simple';
        }
      }
      // Single-word query (no whitespace)
      if (!/\s/.test(trimmed)) {
        return 'simple';
      }
    }

    return 'moderate';
  }

  /**
   * Select the appropriate model for the given message and conversation state.
   *
   * When `config.enabled` is false, always returns `config.defaultModel` so
   * the rest of the app is unaffected.
   *
   * The `conversationTurnCount` parameter allows the router to upgrade a
   * "moderate" conversation to "complex" once it becomes long — long threads
   * require more context-tracking ability than short ones.
   */
  route(userMessage: string, conversationTurnCount: number): RoutingResult {
    if (!this.config.enabled) {
      return {
        modelId: this.config.defaultModel,
        reason: 'routing disabled — using default model',
      };
    }

    let complexity = this.classifyComplexity(userMessage);

    // Long conversations are inherently complex — upgrade if we haven't already
    if (conversationTurnCount > COMPLEX_TURN_THRESHOLD && complexity !== 'complex') {
      complexity = 'complex';
    }

    const modelId = this.config.routes[complexity];
    return {
      modelId,
      reason: `complexity=${complexity} turns=${conversationTurnCount} msgLen=${userMessage.trim().length}`,
    };
  }
}
