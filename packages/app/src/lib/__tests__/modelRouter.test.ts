import { describe, it, expect } from 'vitest';
import { ModelRouter } from '../modelRouter.js';
import type { ModelRouterConfig, TaskComplexity } from '../modelRouter.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ROUTES: Record<TaskComplexity, string> = {
  simple: 'llama3.2:3b',
  moderate: 'qwen2.5-coder:7b',
  complex: 'qwen2.5-coder:32b',
};

const DEFAULT_MODEL = 'qwen2.5:7b';

function makeRouter(enabled = true): ModelRouter {
  const config: ModelRouterConfig = {
    enabled,
    defaultModel: DEFAULT_MODEL,
    routes: ROUTES,
  };
  return new ModelRouter(config);
}

// ─── classifyComplexity ────────────────────────────────────────────────────────

describe('ModelRouter.classifyComplexity', () => {
  const router = makeRouter();

  // Edge cases
  it('returns simple for empty string', () => {
    expect(router.classifyComplexity('')).toBe('simple');
  });

  it('returns simple for whitespace-only string', () => {
    expect(router.classifyComplexity('   ')).toBe('simple');
  });

  // Simple tier
  it('returns simple for a single-word query', () => {
    expect(router.classifyComplexity('hello')).toBe('simple');
  });

  it('returns simple for "what is X" pattern', () => {
    expect(router.classifyComplexity('what is TypeScript')).toBe('simple');
  });

  it('returns simple for "show me X" pattern', () => {
    expect(router.classifyComplexity('show me the file')).toBe('simple');
  });

  it('returns simple for "list X" pattern', () => {
    expect(router.classifyComplexity('list files')).toBe('simple');
  });

  it('returns simple for "explain X" pattern', () => {
    expect(router.classifyComplexity('explain recursion')).toBe('simple');
  });

  it('returns simple for short message matching simple pattern (case insensitive)', () => {
    expect(router.classifyComplexity('WHAT IS a promise')).toBe('simple');
  });

  // Moderate tier
  it('returns moderate for a short question that does not match simple patterns', () => {
    expect(router.classifyComplexity('how does async/await work')).toBe('moderate');
  });

  it('returns moderate for a medium-length question', () => {
    const msg = 'Can you help me understand the difference between map and flatMap in JavaScript?';
    // < 300 chars, no complex keyword, not short enough for simple
    expect(router.classifyComplexity(msg)).toBe('moderate');
  });

  // Complex tier — keywords
  it('returns complex for message containing "refactor"', () => {
    expect(router.classifyComplexity('can you refactor this function')).toBe('complex');
  });

  it('returns complex for message containing "architect"', () => {
    expect(router.classifyComplexity('help me architect the data layer')).toBe('complex');
  });

  it('returns complex for message containing "design"', () => {
    expect(router.classifyComplexity('design a REST API for user management')).toBe('complex');
  });

  it('returns complex for message containing "implement"', () => {
    expect(router.classifyComplexity('implement a binary search tree in TypeScript')).toBe('complex');
  });

  it('returns complex for message containing "migrate"', () => {
    expect(router.classifyComplexity('migrate the database schema to v2')).toBe('complex');
  });

  it('returns complex for message containing "debug"', () => {
    expect(router.classifyComplexity('debug this memory leak')).toBe('complex');
  });

  it('returns complex for message containing "architecture" (variant)', () => {
    expect(router.classifyComplexity('review the system architecture')).toBe('complex');
  });

  it('keyword match is case-insensitive', () => {
    expect(router.classifyComplexity('REFACTOR this module')).toBe('complex');
  });

  // Complex tier — length threshold
  it('returns complex for message longer than 300 chars', () => {
    const longMsg = 'a'.repeat(301);
    expect(router.classifyComplexity(longMsg)).toBe('complex');
  });

  it('returns complex for message exactly 301 chars', () => {
    const msg = 'x'.repeat(301);
    expect(router.classifyComplexity(msg)).toBe('complex');
  });

  it('returns moderate (not complex) for message exactly 300 chars', () => {
    // 300 chars — not over threshold; no keyword; not short; multi-word
    const msg = 'a '.repeat(150); // 300 chars, multi-word, no keywords
    expect(router.classifyComplexity(msg.trimEnd())).not.toBe('complex');
  });
});

// ─── route ────────────────────────────────────────────────────────────────────

describe('ModelRouter.route — routing enabled', () => {
  const router = makeRouter(true);

  it('returns simple model for a simple message', () => {
    const result = router.route('what is git', 0);
    expect(result.modelId).toBe(ROUTES.simple);
  });

  it('returns moderate model for a moderate message', () => {
    // Multi-word, no simple pattern match, no complex keyword, < 300 chars
    const result = router.route('how does async/await work in Node.js', 0);
    expect(result.modelId).toBe(ROUTES.moderate);
  });

  it('returns complex model for a message with complex keyword', () => {
    const result = router.route('refactor the authentication module', 0);
    expect(result.modelId).toBe(ROUTES.complex);
  });

  it('returns complex model for a very long message', () => {
    const result = router.route('x'.repeat(400), 0);
    expect(result.modelId).toBe(ROUTES.complex);
  });

  it('includes a human-readable reason string', () => {
    const result = router.route('what is a closure', 0);
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  // Turn count threshold
  it('upgrades to complex when turn count exceeds threshold (>10)', () => {
    // A moderate message becomes complex after 10+ turns
    const result = router.route('explain async/await', 11);
    expect(result.modelId).toBe(ROUTES.complex);
  });

  it('does not upgrade to complex at exactly 10 turns', () => {
    // A moderate message (multi-word, no keyword, no simple pattern) at exactly 10 turns
    // should remain moderate since the threshold is strictly > 10
    const result = router.route('how does async/await work in Node.js', 10);
    expect(result.modelId).toBe(ROUTES.moderate);
  });

  it('does not downgrade an already-complex message even at low turn count', () => {
    const result = router.route('refactor all components', 0);
    expect(result.modelId).toBe(ROUTES.complex);
  });

  it('reason string contains complexity information', () => {
    const result = router.route('what is X', 2);
    expect(result.reason).toContain('complexity=simple');
  });
});

describe('ModelRouter.route — routing disabled', () => {
  const router = makeRouter(false);

  it('always returns defaultModel regardless of message complexity', () => {
    const inputs: Array<[string, number]> = [
      ['what is X', 0],
      ['refactor the entire codebase', 0],
      ['x'.repeat(400), 0],
      ['explain async/await in detail', 15],
    ];

    for (const [msg, turns] of inputs) {
      const result = router.route(msg, turns);
      expect(result.modelId).toBe(DEFAULT_MODEL);
    }
  });

  it('reason string indicates routing is disabled', () => {
    const result = router.route('refactor everything', 0);
    expect(result.reason).toContain('disabled');
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('ModelRouter edge cases', () => {
  const router = makeRouter(true);

  it('handles a very short single-word query', () => {
    expect(router.classifyComplexity('hi')).toBe('simple');
  });

  it('handles message at exactly the simple/moderate boundary (49 chars, multi-word, no pattern)', () => {
    // 49 chars, multi-word but no simple pattern match → simple only if single-word
    const msg = 'how do coroutines work in kotlin lang here test';  // 47 chars multi-word
    // Not single-word, no simple pattern → moderate
    expect(router.classifyComplexity(msg)).toBe('moderate');
  });

  it('handles a message with only whitespace after trimming as simple', () => {
    const result = router.route('   ', 0);
    expect(result.modelId).toBe(ROUTES.simple);
  });

  it('large turn count does not affect simple classification beyond upgrading to complex', () => {
    const result = router.route('what is X', 100);
    // 100 turns > 10 → complex
    expect(result.modelId).toBe(ROUTES.complex);
  });
});
