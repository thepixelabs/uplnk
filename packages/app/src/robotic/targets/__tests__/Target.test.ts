/**
 * Tests for packages/app/src/robotic/targets/Target.ts
 *
 * Behaviors under test:
 *  - BUILTIN_TARGETS: all expected built-in names are present and have the
 *    required fields (name, displayName, launch, readyRegex)
 *  - resolveTarget: known built-in names resolve to the correct config
 *  - resolveTarget: built-ins take precedence over user-defined targets
 *    with the same name (prevents user config from shadowing a built-in)
 *  - resolveTarget: user-defined custom targets are resolved and their
 *    launch string is split into an args array
 *  - resolveTarget: optional custom fields (promptMarker, quitKeys) are
 *    only attached when present in user config
 *  - resolveTarget: an unknown name falls back to claude-code (never throws)
 *  - resolveTarget: an unknown name with no custom targets still falls back
 *  - resolveTarget: providerHint is preserved on built-in configs
 */

import { describe, it, expect } from 'vitest';
import { BUILTIN_TARGETS, resolveTarget } from '../Target.js';
import type { TargetConfig } from '../Target.js';

// ─── Invariants shared by all valid TargetConfig objects ─────────────────────

function assertValidTargetConfig(target: TargetConfig, name: string): void {
  expect(target.name).toBe(name);
  expect(typeof target.displayName).toBe('string');
  expect(target.displayName.length).toBeGreaterThan(0);
  expect(Array.isArray(target.launch)).toBe(true);
  expect(target.launch.length).toBeGreaterThan(0);
  expect(typeof target.readyRegex).toBe('string');
  expect(target.readyRegex.length).toBeGreaterThan(0);
  // readyRegex must compile without throwing
  expect(() => new RegExp(target.readyRegex)).not.toThrow();
}

// ─── BUILTIN_TARGETS ──────────────────────────────────────────────────────────

describe('BUILTIN_TARGETS', () => {
  it('contains claude-code with a valid config', () => {
    assertValidTargetConfig(BUILTIN_TARGETS['claude-code']!, 'claude-code');
  });

  it('contains gemini with a valid config', () => {
    assertValidTargetConfig(BUILTIN_TARGETS['gemini']!, 'gemini');
  });

  it('contains codex with a valid config', () => {
    assertValidTargetConfig(BUILTIN_TARGETS['codex']!, 'codex');
  });

  it('claude-code has the anthropic providerHint', () => {
    expect(BUILTIN_TARGETS['claude-code']!.providerHint).toBe('anthropic');
  });

  it('gemini has the google providerHint', () => {
    expect(BUILTIN_TARGETS['gemini']!.providerHint).toBe('google');
  });

  it('codex has the openai providerHint', () => {
    expect(BUILTIN_TARGETS['codex']!.providerHint).toBe('openai');
  });

  it('claude-code launch command is ["claude"]', () => {
    expect(BUILTIN_TARGETS['claude-code']!.launch).toEqual(['claude']);
  });
});

// ─── resolveTarget — built-ins ────────────────────────────────────────────────

describe('resolveTarget — built-in targets', () => {
  it('resolves claude-code to the built-in config', () => {
    const result = resolveTarget('claude-code');
    expect(result.name).toBe('claude-code');
    expect(result.providerHint).toBe('anthropic');
  });

  it('resolves gemini to the built-in config', () => {
    const result = resolveTarget('gemini');
    expect(result.name).toBe('gemini');
    expect(result.providerHint).toBe('google');
  });

  it('resolves codex to the built-in config', () => {
    const result = resolveTarget('codex');
    expect(result.name).toBe('codex');
    expect(result.providerHint).toBe('openai');
  });

  it('returns the exact same object reference as BUILTIN_TARGETS', () => {
    // Confirms resolveTarget does not clone built-ins
    expect(resolveTarget('claude-code')).toBe(BUILTIN_TARGETS['claude-code']);
  });
});

// ─── resolveTarget — unknown name fallback ────────────────────────────────────

describe('resolveTarget — unknown name fallback', () => {
  it('falls back to claude-code for a completely unknown name', () => {
    const result = resolveTarget('unknown-ai-tool');
    expect(result.name).toBe('claude-code');
  });

  it('falls back to claude-code when customTargets is undefined', () => {
    const result = resolveTarget('my-custom-tool', undefined);
    expect(result.name).toBe('claude-code');
  });

  it('falls back to claude-code when customTargets is an empty object', () => {
    const result = resolveTarget('phantom', {});
    expect(result.name).toBe('claude-code');
  });

  it('does not throw for any unknown name — always returns a usable config', () => {
    expect(() => resolveTarget('does-not-exist')).not.toThrow();
    const result = resolveTarget('does-not-exist');
    assertValidTargetConfig(result, 'claude-code');
  });
});

// ─── resolveTarget — custom targets ──────────────────────────────────────────

describe('resolveTarget — custom user-defined targets', () => {
  it('resolves a custom target when its name matches', () => {
    const customTargets = {
      'my-bot': {
        launch: 'my-bot --interactive',
        readyRegex: '\\$',
        quitKeys: 'q',
      },
    };

    const result = resolveTarget('my-bot', customTargets);

    expect(result.name).toBe('my-bot');
    expect(result.displayName).toBe('my-bot');
    expect(result.readyRegex).toBe('\\$');
    expect(result.quitKeys).toBe('q');
  });

  it('splits the launch string into a command + args array', () => {
    const customTargets = {
      'my-bot': {
        launch: 'my-bot --flag value',
        readyRegex: '\\$',
        quitKeys: 'q',
      },
    };

    const result = resolveTarget('my-bot', customTargets);

    expect(result.launch).toEqual(['my-bot', '--flag', 'value']);
  });

  it('handles a launch string with only the command and no args', () => {
    const customTargets = {
      'solo': {
        launch: 'solo',
        readyRegex: '>',
        quitKeys: 'q',
      },
    };

    const result = resolveTarget('solo', customTargets);

    expect(result.launch).toEqual(['solo']);
  });

  it('attaches promptMarker when present in custom config', () => {
    const customTargets = {
      'prompt-bot': {
        launch: 'promptbot',
        readyRegex: '\\$',
        quitKeys: 'q',
        promptMarker: '>> ',
      },
    };

    const result = resolveTarget('prompt-bot', customTargets);

    expect(result.promptMarker).toBe('>> ');
  });

  it('does not attach promptMarker when absent from custom config', () => {
    const customTargets = {
      'no-marker': {
        launch: 'nomarker',
        readyRegex: '\\$',
        quitKeys: 'q',
      },
    };

    const result = resolveTarget('no-marker', customTargets);

    expect(result.promptMarker).toBeUndefined();
  });

  it('does not attach providerHint on custom targets', () => {
    const customTargets = {
      'custom': {
        launch: 'custom-tool',
        readyRegex: '>',
        quitKeys: 'q',
      },
    };

    const result = resolveTarget('custom', customTargets);

    expect(result.providerHint).toBeUndefined();
  });
});

// ─── resolveTarget — built-in precedence over custom ─────────────────────────

describe('resolveTarget — built-in takes precedence over custom config', () => {
  it('returns the built-in claude-code config even when a custom target has the same name', () => {
    const customTargets = {
      'claude-code': {
        launch: 'something-else --flag',
        readyRegex: 'READY',
        quitKeys: 'x',
      },
    };

    const result = resolveTarget('claude-code', customTargets);

    // Must not have picked up the custom 'something-else' launch
    expect(result.launch).toEqual(['claude']);
    expect(result.providerHint).toBe('anthropic');
  });

  it('returns the built-in gemini config even when customTargets contains gemini', () => {
    const customTargets = {
      'gemini': {
        launch: 'fake-gemini',
        readyRegex: '>',
        quitKeys: 'q',
      },
    };

    const result = resolveTarget('gemini', customTargets);

    expect(result.launch).toEqual(['gemini']);
    expect(result.providerHint).toBe('google');
  });
});
