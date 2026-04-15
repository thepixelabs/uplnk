/**
 * Tests for packages/app/src/robotic/controller/redactor.ts
 *
 * Security invariants:
 *  - Env vars whose names match a key pattern have their VALUES scrubbed from
 *    output text — this is what prevents API keys from leaking into tmux panes.
 *  - Values shorter than 8 chars are intentionally skipped (too many false
 *    positives with port numbers / common words).
 *  - Regex metacharacters in secret values are escaped before compilation so a
 *    value like "sk.+?key" does not accidentally become a wildcard.
 *  - Custom patterns are applied in addition to env-derived patterns and are
 *    matched case-insensitively.
 *  - Malformed custom patterns (invalid regex syntax) are silently skipped
 *    rather than throwing — the redactor must never crash the transport.
 *  - Patterns are derived from process.env at construction time: mutating the
 *    env after construction has no effect on an existing Redactor instance.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Redactor } from '../redactor.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Save and restore process.env around each test to prevent leakage. */
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
});

afterEach(() => {
  // Replace all keys: remove keys added by the test, restore deleted ones.
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

/**
 * Build a Redactor that matches env vars whose keys contain any of the
 * standard sensitive keywords (API_KEY, TOKEN, SECRET, PASSWORD).
 */
function makeDefaultRedactor(customPatterns: string[] = []): Redactor {
  return new Redactor({
    envPatterns: ['API_KEY', 'TOKEN', 'SECRET', 'PASSWORD'],
    customPatterns,
  });
}

// ─── scrub — basic redaction via env var matching ─────────────────────────────

describe('Redactor.scrub — env-var derived patterns', () => {
  it('replaces an API key value that appears in text', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-abcdefgh';
    const r = makeDefaultRedactor();
    expect(r.scrub('Authorization: sk-ant-abcdefgh')).toBe('Authorization: [REDACTED]');
  });

  it('replaces all occurrences of the same secret in one pass', () => {
    process.env['OPENAI_API_KEY'] = 'sk-openai12345678';
    const r = makeDefaultRedactor();
    const text = 'key=sk-openai12345678 also sk-openai12345678 here';
    expect(r.scrub(text)).toBe('key=[REDACTED] also [REDACTED] here');
  });

  it('redacts a TOKEN env var value', () => {
    process.env['GITHUB_TOKEN'] = 'ghp_supersecret99';
    const r = makeDefaultRedactor();
    expect(r.scrub('Bearer ghp_supersecret99')).toBe('Bearer [REDACTED]');
  });

  it('redacts a SECRET env var value', () => {
    process.env['MY_SECRET'] = 'verysecretvalue';
    const r = makeDefaultRedactor();
    expect(r.scrub('value=verysecretvalue')).toBe('value=[REDACTED]');
  });

  it('redacts a PASSWORD env var value', () => {
    process.env['DB_PASSWORD'] = 'hunter2hunter2';
    const r = makeDefaultRedactor();
    expect(r.scrub('pass=hunter2hunter2')).toBe('pass=[REDACTED]');
  });

  it('leaves text unchanged when it does not contain any secret value', () => {
    process.env['MY_API_KEY'] = 'aaaabbbbccccdddd';
    const r = makeDefaultRedactor();
    expect(r.scrub('nothing sensitive here')).toBe('nothing sensitive here');
  });

  it('handles text that is entirely a secret value', () => {
    process.env['MY_API_KEY'] = 'totalsecret12345';
    const r = makeDefaultRedactor();
    expect(r.scrub('totalsecret12345')).toBe('[REDACTED]');
  });
});

// ─── scrub — minimum length guard (< 8 chars skipped) ────────────────────────

describe('Redactor.scrub — minimum value length guard', () => {
  it('does NOT redact a secret value that is exactly 7 characters long', () => {
    process.env['SHORT_API_KEY'] = 'abc1234'; // 7 chars
    const r = makeDefaultRedactor();
    // "abc1234" appears in the text but must not be redacted (too short)
    expect(r.scrub('token abc1234 end')).toBe('token abc1234 end');
  });

  it('does NOT redact an empty secret value', () => {
    process.env['EMPTY_TOKEN'] = '';
    const r = makeDefaultRedactor();
    // Empty value — no pattern should be built
    expect(r.scrub('some text')).toBe('some text');
  });

  it('does redact a secret value that is exactly 8 characters long', () => {
    process.env['BORDER_API_KEY'] = 'abcd1234'; // exactly 8 chars
    const r = makeDefaultRedactor();
    expect(r.scrub('key=abcd1234')).toBe('key=[REDACTED]');
  });

  it('does redact a secret value that is longer than 8 characters', () => {
    process.env['LONG_API_KEY'] = 'abcdefghij'; // 10 chars
    const r = makeDefaultRedactor();
    expect(r.scrub('x abcdefghij y')).toBe('x [REDACTED] y');
  });
});

// ─── scrub — envPatterns key-name matching ────────────────────────────────────

describe('Redactor — envPattern key-name matching', () => {
  it('only redacts env vars whose KEYS match the supplied patterns', () => {
    process.env['SAFE_VAR'] = 'shouldnotberedacted00';
    process.env['MY_API_KEY'] = 'shouldberedacted00';
    const r = makeDefaultRedactor();
    // "shouldnotberedacted00" must survive — its key does not match any pattern
    const result = r.scrub('a shouldnotberedacted00 b shouldberedacted00 c');
    expect(result).toBe('a shouldnotberedacted00 b [REDACTED] c');
  });

  it('is case-insensitive when matching env var KEY names', () => {
    process.env['my_api_key'] = 'mixedcasekey123456';
    // envPattern 'API_KEY' with /i flag must match 'my_api_key'
    const r = makeDefaultRedactor();
    expect(r.scrub('mixedcasekey123456')).toBe('[REDACTED]');
  });

  it('does not redact when envPatterns array is empty', () => {
    process.env['MY_API_KEY'] = 'shouldsurvive12345';
    const r = new Redactor({ envPatterns: [], customPatterns: [] });
    expect(r.scrub('shouldsurvive12345')).toBe('shouldsurvive12345');
  });

  it('ignores an invalid regex in envPatterns and still processes valid ones', () => {
    process.env['MY_TOKEN'] = 'validtoken12345678';
    // '[invalid' is not valid regex — must not throw
    const r = new Redactor({
      envPatterns: ['[invalid', 'TOKEN'],
      customPatterns: [],
    });
    expect(r.scrub('validtoken12345678')).toBe('[REDACTED]');
  });
});

// ─── scrub — regex metacharacter escaping in secret values ───────────────────

describe('Redactor — escapeRegex: metacharacters in secret values', () => {
  it('treats a dot in the secret value as a literal character, not a wildcard', () => {
    // Value: "sk.ant.key12345" — the dots must be escaped so they match
    // only a literal dot, not any character.
    process.env['ANTHROPIC_API_KEY'] = 'sk.ant.key12345';
    const r = makeDefaultRedactor();
    // Text contains the literal value — should be redacted
    expect(r.scrub('key=sk.ant.key12345')).toBe('key=[REDACTED]');
    // Text that would match if dot were a wildcard but not literal — must NOT be redacted
    expect(r.scrub('key=skXantXkey12345')).toBe('key=skXantXkey12345');
  });

  it('treats a + in the secret value as a literal character', () => {
    process.env['MY_SECRET'] = 'pas+word+long+val';
    const r = makeDefaultRedactor();
    expect(r.scrub('x pas+word+long+val y')).toBe('x [REDACTED] y');
    // Without escaping, 'pas+word+long+val' as regex would mean "one or more s"
    // — the string 'passsword+long+val' would not match the literal. With
    // escaping the pattern only matches the exact literal string.
    expect(r.scrub('x passsword+long+val y')).toBe('x passsword+long+val y');
  });

  it('treats parentheses in the secret value as literal characters', () => {
    process.env['MY_TOKEN'] = 'tok(en)long1234';
    const r = makeDefaultRedactor();
    expect(r.scrub('auth tok(en)long1234 ok')).toBe('auth [REDACTED] ok');
  });

  it('treats a $ in the secret value as a literal character', () => {
    process.env['MY_API_KEY'] = 'price$is$right99';
    const r = makeDefaultRedactor();
    expect(r.scrub('val=price$is$right99')).toBe('val=[REDACTED]');
  });

  it('treats square brackets in the secret value as literal characters', () => {
    process.env['MY_API_KEY'] = 'key[with]brackets1';
    const r = makeDefaultRedactor();
    expect(r.scrub('k=key[with]brackets1')).toBe('k=[REDACTED]');
  });

  it('treats a backslash in the secret value as a literal character', () => {
    process.env['MY_TOKEN'] = 'back\\slash\\token1';
    const r = makeDefaultRedactor();
    expect(r.scrub('back\\slash\\token1')).toBe('[REDACTED]');
  });
});

// ─── scrub — custom patterns ──────────────────────────────────────────────────

describe('Redactor — customPatterns', () => {
  it('applies a custom pattern to redact text matching a given format', () => {
    const r = new Redactor({
      envPatterns: [],
      customPatterns: ['sk-[a-z0-9]{20,}'],
    });
    expect(r.scrub('token: sk-abcdefghijklmnopqrst ok')).toBe('token: [REDACTED] ok');
  });

  it('applies custom patterns case-insensitively (gi flags)', () => {
    const r = new Redactor({
      envPatterns: [],
      customPatterns: ['bearer [a-z0-9]+'],
    });
    // Uppercase BEARER should also match
    expect(r.scrub('BEARER abc123xyz')).toBe('[REDACTED]');
  });

  it('silently ignores an invalid custom pattern and continues scrubbing', () => {
    process.env['MY_API_KEY'] = 'good_secret_value1';
    // '[bad' is not valid regex
    const r = new Redactor({
      envPatterns: ['API_KEY'],
      customPatterns: ['[bad pattern', 'bearer [a-z0-9]+'],
    });
    // The invalid pattern is skipped, valid env pattern still works
    expect(r.scrub('good_secret_value1')).toBe('[REDACTED]');
    // The valid custom pattern also works
    expect(r.scrub('bearer xyz123abc')).toBe('[REDACTED]');
  });

  it('applies multiple custom patterns in sequence', () => {
    const r = new Redactor({
      envPatterns: [],
      customPatterns: ['FOO_\\w+', 'BAR_\\w+'],
    });
    expect(r.scrub('FOO_secret and BAR_other here')).toBe('[REDACTED] and [REDACTED] here');
  });
});

// ─── snapshot isolation: mutations after construction ─────────────────────────

describe('Redactor — env snapshot at construction time', () => {
  it('does not redact a secret added to process.env after construction', () => {
    // Build the redactor before setting the env var
    const r = makeDefaultRedactor();
    process.env['LATE_API_KEY'] = 'addedafterbuild99';
    // The Redactor was built before this key existed — should not redact it
    expect(r.scrub('addedafterbuild99')).toBe('addedafterbuild99');
  });

  it('continues to redact a secret even after its env var is deleted', () => {
    process.env['MY_API_KEY'] = 'builttimesecret99';
    const r = makeDefaultRedactor();
    delete process.env['MY_API_KEY'];
    // Pattern was compiled at construction — deleting the var has no effect
    expect(r.scrub('builttimesecret99')).toBe('[REDACTED]');
  });
});

// ─── scrub — output is a copy, not a mutation ─────────────────────────────────

describe('Redactor.scrub — return value', () => {
  it('returns a new string and does not mutate the input', () => {
    process.env['MY_API_KEY'] = 'immutable_test_key';
    const r = makeDefaultRedactor();
    const original = 'prefix immutable_test_key suffix';
    const result = r.scrub(original);
    expect(result).toBe('prefix [REDACTED] suffix');
    // Original string reference is unchanged
    expect(original).toBe('prefix immutable_test_key suffix');
  });

  it('returns an empty string unchanged when given an empty string', () => {
    const r = makeDefaultRedactor();
    expect(r.scrub('')).toBe('');
  });
});
