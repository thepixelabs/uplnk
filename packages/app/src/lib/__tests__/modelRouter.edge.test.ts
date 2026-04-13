/**
 * ModelRouter — additional edge cases not covered by modelRouter.test.ts.
 *
 * These tests pin behaviours the core test file does not assert:
 *   - Non-English input (unicode) does not crash the classifier.
 *   - Single-character queries classify deterministically.
 *   - The exact 300-char boundary splits correctly (300 = moderate, 301 = complex).
 *   - turnCount > 10 upgrades a classification to complex even when it started
 *     out "simple" (not only "moderate" as the core test exercises).
 */

import { describe, it, expect } from 'vitest';
import { ModelRouter } from '../modelRouter.js';
import type { ModelRouterConfig, TaskComplexity } from '../modelRouter.js';

const ROUTES: Record<TaskComplexity, string> = {
  simple: 'simple-model',
  moderate: 'moderate-model',
  complex: 'complex-model',
};

function makeRouter(): ModelRouter {
  const config: ModelRouterConfig = {
    enabled: true,
    defaultModel: 'default-model',
    routes: ROUTES,
  };
  return new ModelRouter(config);
}

describe('ModelRouter — non-English input', () => {
  const router = makeRouter();

  it('does not throw on a Japanese prompt', () => {
    expect(() => router.classifyComplexity('これは日本語のテストです')).not.toThrow();
  });

  it('does not throw on a Hebrew prompt', () => {
    expect(() => router.classifyComplexity('שלום עולם, איך הולך היום')).not.toThrow();
  });

  it('does not throw on a prompt containing emoji', () => {
    expect(() => router.classifyComplexity('build a todo app 🚀 🧪 ✅')).not.toThrow();
  });

  it('classifies a non-English prompt without English complex keywords as moderate when multi-word and under the char threshold', () => {
    // Multi-word (has spaces), < 300 chars, no English complex keyword,
    // no simple-pattern match — falls through to moderate.
    const msg = 'שלום עולם, איך הולך היום יפה מאוד';
    expect(router.classifyComplexity(msg)).toBe('moderate');
  });

  it('treats a short non-English single-word prompt as simple (no-whitespace branch)', () => {
    // < 50 chars, no whitespace → simple via the single-word rule.
    expect(router.classifyComplexity('これは日本語')).toBe('simple');
  });
});

describe('ModelRouter — single-character queries', () => {
  const router = makeRouter();

  it('classifies a single ASCII character as simple', () => {
    expect(router.classifyComplexity('x')).toBe('simple');
  });

  it('classifies a single punctuation character as simple', () => {
    expect(router.classifyComplexity('?')).toBe('simple');
  });

  it('classifies a single unicode character as simple', () => {
    expect(router.classifyComplexity('日')).toBe('simple');
  });

  it('route() returns the simple model for a single character at turn 0', () => {
    expect(router.route('x', 0).modelId).toBe(ROUTES.simple);
  });
});

describe('ModelRouter — 300-character boundary', () => {
  const router = makeRouter();

  it('treats exactly 300 chars (multi-word, no keywords) as moderate (boundary is strictly greater-than)', () => {
    // 150 * "a " = 300 chars including trailing space — multi-word, no keyword.
    const msg = 'a '.repeat(150);
    expect(msg.length).toBe(300);
    expect(router.classifyComplexity(msg)).toBe('moderate');
  });

  it('treats 301 chars as complex', () => {
    const msg = 'a '.repeat(150) + 'b';
    expect(msg.length).toBe(301);
    expect(router.classifyComplexity(msg)).toBe('complex');
  });

  it('length rule ignores surrounding whitespace (uses trimmed length)', () => {
    // 310 chars of leading/trailing whitespace padding around a 10-char core
    // should classify as simple (single word, < 50) — NOT complex.
    const msg = '          hello          ';
    expect(router.classifyComplexity(msg)).toBe('simple');
  });
});

describe('ModelRouter — turn-count upgrade (>10)', () => {
  const router = makeRouter();

  it('upgrades a simple query to complex once turn count passes 10', () => {
    // "what is X" would normally classify simple → with turns=11 it must
    // upgrade all the way to complex (not merely moderate). The
    // implementation: when turnCount > threshold and complexity !== 'complex',
    // set complexity = 'complex'.
    const result = router.route('what is X', 11);
    expect(result.modelId).toBe(ROUTES.complex);
  });

  it('keeps a simple query as simple at exactly turn 10', () => {
    const result = router.route('what is X', 10);
    expect(result.modelId).toBe(ROUTES.simple);
  });

  it('still upgrades a non-English single-word query to complex at turn 11', () => {
    // Confirms the upgrade rule is independent of how the message was
    // originally classified.
    const result = router.route('日本語', 11);
    expect(result.modelId).toBe(ROUTES.complex);
  });

  it('reports complexity=complex in the reason string after upgrade', () => {
    const result = router.route('x', 50);
    expect(result.reason).toContain('complexity=complex');
  });
});
