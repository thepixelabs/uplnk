/**
 * Tests for the safe expression evaluator (expr.ts).
 *
 * All three public surfaces are exercised:
 *   - evaluateCondition   — returns boolean, fail-closed
 *   - resolveExpression   — returns raw value
 *   - interpolate         — template string substitution
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateCondition,
  resolveExpression,
  interpolate,
  type EvalContext,
} from '../expr.js';

// ─── Shared context factory ───────────────────────────────────────────────────

function makeCtx(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    stepOutputs: {},
    inputs: {},
    variables: {},
    ...overrides,
  };
}

const emptyCtx = makeCtx();

// ─── Literals ─────────────────────────────────────────────────────────────────

describe('evaluateCondition — literals', () => {
  it('returns true for the literal "true"', () => {
    expect(evaluateCondition('true', emptyCtx)).toBe(true);
  });

  it('returns false for the literal "false"', () => {
    expect(evaluateCondition('false', emptyCtx)).toBe(false);
  });

  it('returns true for a non-zero number literal', () => {
    expect(evaluateCondition('42', emptyCtx)).toBe(true);
  });

  it('returns false for the number literal 0', () => {
    expect(evaluateCondition('0', emptyCtx)).toBe(false);
  });

  it('returns true for a non-empty string literal', () => {
    expect(evaluateCondition('"hello"', emptyCtx)).toBe(true);
  });

  it('returns false for an empty string literal', () => {
    expect(evaluateCondition('""', emptyCtx)).toBe(false);
  });

  it('treats null literal as falsy', () => {
    expect(evaluateCondition('null', emptyCtx)).toBe(false);
  });

  it('handles floating-point number literals', () => {
    expect(evaluateCondition('3.14', emptyCtx)).toBe(true);
  });

  it('handles single-quoted string literals', () => {
    expect(evaluateCondition("'world'", emptyCtx)).toBe(true);
  });
});

// ─── Comparison operators ─────────────────────────────────────────────────────

describe('evaluateCondition — comparison operators', () => {
  it('== returns true when both sides are the same number', () => {
    expect(evaluateCondition('42 == 42', emptyCtx)).toBe(true);
  });

  it('== returns false when number sides differ', () => {
    expect(evaluateCondition('42 == 43', emptyCtx)).toBe(false);
  });

  it('== returns true for identical string literals', () => {
    expect(evaluateCondition('"hello" == "hello"', emptyCtx)).toBe(true);
  });

  it('== returns false for different string literals', () => {
    expect(evaluateCondition('"hello" == "world"', emptyCtx)).toBe(false);
  });

  it('!= returns true when sides differ', () => {
    expect(evaluateCondition('1 != 2', emptyCtx)).toBe(true);
  });

  it('!= returns false when sides are equal', () => {
    expect(evaluateCondition('5 != 5', emptyCtx)).toBe(false);
  });

  it('< returns true when left is less', () => {
    expect(evaluateCondition('1 < 2', emptyCtx)).toBe(true);
  });

  it('< returns false when left is greater', () => {
    expect(evaluateCondition('3 < 2', emptyCtx)).toBe(false);
  });

  it('<= returns true for equal values', () => {
    expect(evaluateCondition('5 <= 5', emptyCtx)).toBe(true);
  });

  it('<= returns true when left is less', () => {
    expect(evaluateCondition('4 <= 5', emptyCtx)).toBe(true);
  });

  it('> returns true when left is greater', () => {
    expect(evaluateCondition('10 > 3', emptyCtx)).toBe(true);
  });

  it('>= returns true for equal values', () => {
    expect(evaluateCondition('7 >= 7', emptyCtx)).toBe(true);
  });

  it('>= returns false when left is less', () => {
    expect(evaluateCondition('6 >= 7', emptyCtx)).toBe(false);
  });
});

// ─── Cross-type equality (string/number leniency) ─────────────────────────────

describe('evaluateCondition — cross-type equality', () => {
  it('number == string is true when values are numerically equal', () => {
    // e.g. inputs.retries arrived as "3" but the condition checks == 3
    const ctx = makeCtx({ inputs: { retries: '3' } });
    expect(evaluateCondition('inputs.retries == 3', ctx)).toBe(true);
  });

  it('string == number is true when values are numerically equal', () => {
    const ctx = makeCtx({ inputs: { count: 42 } });
    expect(evaluateCondition('inputs.count == "42"', ctx)).toBe(true);
  });

  it('number 42 != string "42" is false (they are equal)', () => {
    expect(evaluateCondition('42 != "42"', emptyCtx)).toBe(false);
  });

  it('string "null" does NOT equal null (no cross-type coercion for null)', () => {
    expect(evaluateCondition('"null" == null', emptyCtx)).toBe(false);
  });

  it('null == null is true', () => {
    expect(evaluateCondition('null == null', emptyCtx)).toBe(true);
  });

  it('null != null is false', () => {
    expect(evaluateCondition('null != null', emptyCtx)).toBe(false);
  });
});

// ─── Logical operators ────────────────────────────────────────────────────────

describe('evaluateCondition — logical operators', () => {
  it('true && true returns true', () => {
    expect(evaluateCondition('true && true', emptyCtx)).toBe(true);
  });

  it('true && false returns false', () => {
    expect(evaluateCondition('true && false', emptyCtx)).toBe(false);
  });

  it('false && true returns false', () => {
    expect(evaluateCondition('false && true', emptyCtx)).toBe(false);
  });

  it('false || true returns true', () => {
    expect(evaluateCondition('false || true', emptyCtx)).toBe(true);
  });

  it('false || false returns false', () => {
    expect(evaluateCondition('false || false', emptyCtx)).toBe(false);
  });

  it('!true returns false', () => {
    expect(evaluateCondition('!true', emptyCtx)).toBe(false);
  });

  it('!false returns true', () => {
    expect(evaluateCondition('!false', emptyCtx)).toBe(true);
  });

  it('!! double-negation restores original truthiness', () => {
    expect(evaluateCondition('!!true', emptyCtx)).toBe(true);
    expect(evaluateCondition('!!false', emptyCtx)).toBe(false);
  });

  it('operator precedence: && binds tighter than ||', () => {
    // false || (true && true) == true
    expect(evaluateCondition('false || true && true', emptyCtx)).toBe(true);
    // (false || true) && false == false
    expect(evaluateCondition('(false || true) && false', emptyCtx)).toBe(false);
  });
});

// ─── Parentheses ──────────────────────────────────────────────────────────────

describe('evaluateCondition — parentheses', () => {
  it('respects explicit grouping over default precedence', () => {
    // Without parens: !(true) && false → false && false → false
    // With parens:    !(true && false) → !false → true
    expect(evaluateCondition('!(true && false)', emptyCtx)).toBe(true);
  });

  it('handles nested parentheses', () => {
    expect(evaluateCondition('((true))', emptyCtx)).toBe(true);
  });

  it('single value in parens is still evaluated', () => {
    expect(evaluateCondition('(42)', emptyCtx)).toBe(true);
    expect(evaluateCondition('(0)', emptyCtx)).toBe(false);
  });
});

// ─── Path resolution ─────────────────────────────────────────────────────────

describe('evaluateCondition — path resolution', () => {
  it('resolves inputs.paramName to its value', () => {
    const ctx = makeCtx({ inputs: { ready: true } });
    expect(evaluateCondition('inputs.ready', ctx)).toBe(true);
  });

  it('resolves vars.varName to its value', () => {
    const ctx = makeCtx({ variables: { flag: true } });
    expect(evaluateCondition('vars.flag', ctx)).toBe(true);
  });

  it('resolves steps.stepId.output to the step output', () => {
    const ctx = makeCtx({ stepOutputs: { fetchData: 'some result' } });
    expect(evaluateCondition('steps.fetchData.output', ctx)).toBe(true);
  });

  it('falsy step output (empty string) evaluates as false', () => {
    const ctx = makeCtx({ stepOutputs: { step1: '' } });
    expect(evaluateCondition('steps.step1.output', ctx)).toBe(false);
  });

  it('falsy step output (zero) evaluates as false', () => {
    const ctx = makeCtx({ stepOutputs: { step1: 0 } });
    expect(evaluateCondition('steps.step1.output', ctx)).toBe(false);
  });

  it('can compare step output to a literal', () => {
    const ctx = makeCtx({ stepOutputs: { classify: 'positive' } });
    expect(evaluateCondition('steps.classify.output == "positive"', ctx)).toBe(true);
    expect(evaluateCondition('steps.classify.output == "negative"', ctx)).toBe(false);
  });

  it('can compare input to a number', () => {
    const ctx = makeCtx({ inputs: { maxRetries: 3 } });
    expect(evaluateCondition('inputs.maxRetries > 0', ctx)).toBe(true);
    expect(evaluateCondition('inputs.maxRetries > 10', ctx)).toBe(false);
  });

  it('can compare variable to a boolean', () => {
    const ctx = makeCtx({ variables: { done: false } });
    expect(evaluateCondition('vars.done == false', ctx)).toBe(true);
    expect(evaluateCondition('vars.done == true', ctx)).toBe(false);
  });
});

// ─── Missing / unknown paths ──────────────────────────────────────────────────

describe('evaluateCondition — missing paths', () => {
  it('missing steps.X.output evaluates as falsy', () => {
    expect(evaluateCondition('steps.missing.output', emptyCtx)).toBe(false);
  });

  it('missing inputs.X evaluates as falsy', () => {
    expect(evaluateCondition('inputs.missing', emptyCtx)).toBe(false);
  });

  it('missing vars.X evaluates as falsy', () => {
    expect(evaluateCondition('vars.missing', emptyCtx)).toBe(false);
  });

  it('missing path == null is true (undefined normalised to null)', () => {
    expect(evaluateCondition('steps.missing.output == null', emptyCtx)).toBe(true);
  });

  it('missing path != null is false', () => {
    expect(evaluateCondition('steps.missing.output != null', emptyCtx)).toBe(false);
  });

  it('unrecognised path prefix evaluates as falsy (not a crash)', () => {
    // "foo.bar" is not steps/inputs/vars — should be falsy, not throw
    expect(evaluateCondition('foo.bar', emptyCtx)).toBe(false);
  });

  it('steps path without .output sub-field returns undefined (falsy)', () => {
    // steps.X.field where field != 'output' is not supported
    const ctx = makeCtx({ stepOutputs: { s: 'val' } });
    expect(evaluateCondition('steps.s.other', ctx)).toBe(false);
  });
});

// ─── Object output coercion ───────────────────────────────────────────────────

describe('evaluateCondition — complex output coercion', () => {
  it('object step output is stringified — truthy because non-empty', () => {
    const ctx = makeCtx({ stepOutputs: { s: { key: 'value' } } });
    // coercePrimitive stringifies objects, non-empty string is truthy
    expect(evaluateCondition('steps.s.output', ctx)).toBe(true);
  });
});

// ─── Fail-closed: malformed or unsupported syntax ────────────────────────────

describe('evaluateCondition — fail-closed', () => {
  it('returns false for an empty expression', () => {
    expect(evaluateCondition('', emptyCtx)).toBe(false);
  });

  it('returns false for whitespace-only expression', () => {
    expect(evaluateCondition('   ', emptyCtx)).toBe(false);
  });

  it('returns false for unrecognised syntax (does not throw)', () => {
    expect(evaluateCondition('???', emptyCtx)).toBe(false);
  });

  it('returns false for a bare @ character', () => {
    expect(evaluateCondition('@', emptyCtx)).toBe(false);
  });
});

// ─── resolveExpression — raw value, not coerced to boolean ───────────────────

describe('resolveExpression', () => {
  it('returns the number value directly', () => {
    expect(resolveExpression('42', emptyCtx)).toBe(42);
  });

  it('returns the string value directly', () => {
    expect(resolveExpression('"hello"', emptyCtx)).toBe('hello');
  });

  it('returns boolean true directly', () => {
    expect(resolveExpression('true', emptyCtx)).toBe(true);
  });

  it('returns null for null literal', () => {
    expect(resolveExpression('null', emptyCtx)).toBe(null);
  });

  it('returns the step output value (not boolean-coerced)', () => {
    const ctx = makeCtx({ stepOutputs: { items: ['a', 'b', 'c'] } });
    // coercePrimitive stringifies arrays — so we get a string, not the array
    const result = resolveExpression('steps.items.output', ctx);
    expect(typeof result).toBe('string');
  });

  it('returns inputs value directly', () => {
    const ctx = makeCtx({ inputs: { count: 5 } });
    expect(resolveExpression('inputs.count', ctx)).toBe(5);
  });

  it('returns undefined for an unknown path', () => {
    expect(resolveExpression('steps.missing.output', emptyCtx)).toBeNull();
  });

  it('returns undefined on malformed expression', () => {
    expect(resolveExpression('', emptyCtx)).toBeUndefined();
  });
});

// ─── interpolate ─────────────────────────────────────────────────────────────

describe('interpolate', () => {
  it('replaces a ${inputs.X} placeholder with its value', () => {
    const ctx = makeCtx({ inputs: { name: 'Alice' } });
    expect(interpolate('Hello, ${inputs.name}!', ctx)).toBe('Hello, Alice!');
  });

  it('replaces a ${vars.X} placeholder with its value', () => {
    const ctx = makeCtx({ variables: { greeting: 'Bonjour' } });
    expect(interpolate('${vars.greeting}, world', ctx)).toBe('Bonjour, world');
  });

  it('replaces a ${steps.X.output} placeholder with the step output', () => {
    const ctx = makeCtx({ stepOutputs: { summarise: 'Short text.' } });
    expect(interpolate('Summary: ${steps.summarise.output}', ctx)).toBe('Summary: Short text.');
  });

  it('replaces multiple placeholders in a single template', () => {
    const ctx = makeCtx({ inputs: { first: 'Jane', last: 'Doe' } });
    const result = interpolate('${inputs.first} ${inputs.last}', ctx);
    expect(result).toBe('Jane Doe');
  });

  it('replaces a missing path with an empty string', () => {
    expect(interpolate('Value: ${inputs.missing}', emptyCtx)).toBe('Value: ');
  });

  it('leaves template unchanged when there are no placeholders', () => {
    expect(interpolate('plain text', emptyCtx)).toBe('plain text');
  });

  it('replaces a null/undefined resolved value with an empty string', () => {
    const ctx = makeCtx({ inputs: { val: null } });
    // inputs.val resolves to null → empty string in output
    expect(interpolate('result: ${inputs.val}', ctx)).toBe('result: ');
  });

  it('handles escaped characters inside a string literal placeholder', () => {
    // The evaluator supports backslash escapes inside quoted strings
    const ctx = makeCtx({ inputs: { path: 'a/b' } });
    expect(interpolate('${inputs.path}', ctx)).toBe('a/b');
  });
});
