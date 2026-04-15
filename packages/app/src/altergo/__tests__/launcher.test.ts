/**
 * Tests for packages/app/src/altergo/launcher.ts
 *
 * Security invariants:
 *  - validateArgName rejects shell metacharacters, path traversal (..), leading
 *    dots, and empty strings — even though we use array-form spawn (so the OS
 *    never sees a shell), the names are used as directory paths inside altergo.
 *  - sanitiseEnv strips all UPLNK_* vars, all well-known secret key names, and
 *    all names matching generic *_API_KEY / *_TOKEN / *_SECRET / *_PASSWORD
 *    patterns before passing the environment to the child process.
 *  - sanitiseEnv preserves infrastructure vars (PATH, HOME, USER, etc.).
 *  - launchAltergoAccount uses array-form spawn (never a shell string).
 *  - In detach mode: stdio is 'ignore', detached is true, unref() is called.
 *  - In non-detach mode: stdio is 'inherit', onExit callback fires with the
 *    exit code when the child process exits.
 *  - account and provider are passed as separate elements in the args array,
 *    not concatenated into binaryPath.
 *
 * Mocking strategy
 * ─────────────────
 * launcher.ts imports `spawn` from `node:child_process` at the top level.
 * vi.mock factories are hoisted before any const declarations in the test
 * file, so we use vi.hoisted() to declare mock state that is safe to
 * reference inside the factory closure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted mock state ───────────────────────────────────────────────────────

const { spawnMock, mockChildUnref, mockChildOn } = vi.hoisted(() => {
  const mockChildUnref = vi.fn();
  const mockChildOn = vi.fn();
  const mockChild = { unref: mockChildUnref, on: mockChildOn };
  const spawnMock = vi.fn(() => mockChild);
  return { spawnMock, mockChildUnref, mockChildOn };
});

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

// ─── Subject under test ───────────────────────────────────────────────────────

import { launchAltergoAccount } from '../launcher.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  vi.clearAllMocks();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

/**
 * Extract the `env` option that was passed to the most recent spawn() call.
 */
function spawnEnvArg(): NodeJS.ProcessEnv {
  const lastCall = spawnMock.mock.calls[spawnMock.mock.calls.length - 1] as unknown as [string, string[], { env?: NodeJS.ProcessEnv }] | undefined;
  const opts = lastCall?.[2];
  return opts?.env ?? {};
}

// ─── validateArgName — account ────────────────────────────────────────────────

describe('launchAltergoAccount — account name validation', () => {
  it('throws for an empty account name', () => {
    expect(() => launchAltergoAccount('/usr/bin/altergo', '')).toThrow(/must not be empty/i);
  });

  it('throws for an account name starting with a dot (path traversal risk)', () => {
    expect(() => launchAltergoAccount('/usr/bin/altergo', '.hidden')).toThrow(
      /must not start with a dot/i,
    );
  });

  it('throws for a path traversal sequence as the account name', () => {
    expect(() => launchAltergoAccount('/usr/bin/altergo', '../etc')).toThrow(
      /must not start with a dot/i,
    );
  });

  const shellMetachars: Array<[string, string]> = [
    ['semicolon', 'acc;ount'],
    ['pipe', 'acc|ount'],
    ['ampersand', 'acc&ount'],
    ['dollar sign', 'acc$ount'],
    ['backtick', 'acc`ount'],
    ['open paren', 'acc(ount'],
    ['close paren', 'acc)ount'],
    ['less-than', 'acc<ount'],
    ['greater-than', 'acc>ount'],
    ['backslash', 'acc\\ount'],
    ['space', 'acc ount'],
    ['forward slash', 'acc/ount'],
  ];

  it.each(shellMetachars)('throws for account name containing %s', (_label, name) => {
    expect(() => launchAltergoAccount('/usr/bin/altergo', name)).toThrow(
      /invalid characters|must not start with a dot/i,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  const validNames: Array<[string, string]> = [
    ['simple alpha', 'alice'],
    ['digits', 'agent42'],
    ['hyphen', 'my-agent'],
    ['underscore', 'my_agent'],
    ['dot in middle', 'my.agent'],
    ['mixed', 'Agent-007_v2.0'],
    // The validator only blocks a LEADING dot, not an embedded double-dot.
    // The leading-dot check already prevents "../etc" traversal (starts with ".").
    ['double dot embedded (allowed by design)', 'acc..ount'],
  ];

  it.each(validNames)('accepts valid account name — %s', (_label, name) => {
    expect(() => launchAltergoAccount('/usr/bin/altergo', name)).not.toThrow();
  });
});

// ─── validateArgName — provider ───────────────────────────────────────────────

describe('launchAltergoAccount — provider name validation', () => {
  it('throws for an empty provider name', () => {
    expect(() => launchAltergoAccount('/usr/bin/altergo', 'alice', '')).toThrow(
      /must not be empty/i,
    );
  });

  it('throws for a provider name with shell metacharacters', () => {
    expect(() => launchAltergoAccount('/usr/bin/altergo', 'alice', 'claude;code')).toThrow(
      /invalid characters/i,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('throws for a provider name starting with a dot', () => {
    expect(() => launchAltergoAccount('/usr/bin/altergo', 'alice', '.hidden')).toThrow(
      /must not start with a dot/i,
    );
  });

  it('does not call spawn when provider validation fails', () => {
    expect(() => launchAltergoAccount('/usr/bin/altergo', 'alice', 'bad|provider')).toThrow();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('accepts a valid provider name', () => {
    expect(() => launchAltergoAccount('/usr/bin/altergo', 'alice', 'claude-code')).not.toThrow();
  });
});

// ─── spawn argument shape ─────────────────────────────────────────────────────

describe('launchAltergoAccount — spawn argument shape', () => {
  it('calls spawn with binaryPath as the first argument', () => {
    launchAltergoAccount('/usr/local/bin/altergo', 'alice');
    const [binary] = spawnMock.mock.calls[0] as unknown as [string, ...unknown[]];
    expect(binary).toBe('/usr/local/bin/altergo');
  });

  it('passes account as the first element of the args array', () => {
    launchAltergoAccount('/usr/bin/altergo', 'alice');
    const [, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    expect(args[0]).toBe('alice');
  });

  it('omits provider from args when provider is undefined', () => {
    launchAltergoAccount('/usr/bin/altergo', 'alice');
    const [, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    expect(args).toHaveLength(1);
  });

  it('appends provider as the second arg element when provided', () => {
    launchAltergoAccount('/usr/bin/altergo', 'alice', 'claude-code');
    const [, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('alice');
    expect(args[1]).toBe('claude-code');
  });

  it('never concatenates account or provider into the binary path string', () => {
    launchAltergoAccount('/usr/bin/altergo', 'alice', 'claude-code');
    const [binary] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    expect(binary).not.toContain('alice');
    expect(binary).not.toContain('claude-code');
  });
});

// ─── detach mode (default) ────────────────────────────────────────────────────

describe('launchAltergoAccount — detach mode (default)', () => {
  it('sets stdio: "ignore" in detach mode', () => {
    launchAltergoAccount('/usr/bin/altergo', 'alice');
    const [, , opts] = spawnMock.mock.calls[0] as unknown as [string, string[], { stdio: string }];
    expect(opts.stdio).toBe('ignore');
  });

  it('sets detached: true in detach mode', () => {
    launchAltergoAccount('/usr/bin/altergo', 'alice');
    const [, , opts] = spawnMock.mock.calls[0] as unknown as [string, string[], { detached: boolean }];
    expect(opts.detached).toBe(true);
  });

  it('calls unref() on the child in detach mode (fire-and-forget)', () => {
    launchAltergoAccount('/usr/bin/altergo', 'alice');
    expect(mockChildUnref).toHaveBeenCalledOnce();
  });

  it('does not register an on-exit listener in detach mode', () => {
    launchAltergoAccount('/usr/bin/altergo', 'alice');
    expect(mockChildOn).not.toHaveBeenCalled();
  });

  it('explicit detach: true behaves identically to the default', () => {
    launchAltergoAccount('/usr/bin/altergo', 'alice', undefined, { detach: true });
    const [, , opts] = spawnMock.mock.calls[0] as unknown as [string, string[], { stdio: string; detached: boolean }];
    expect(opts.stdio).toBe('ignore');
    expect(opts.detached).toBe(true);
    expect(mockChildUnref).toHaveBeenCalledOnce();
  });
});

// ─── non-detach mode ──────────────────────────────────────────────────────────

describe('launchAltergoAccount — non-detach mode', () => {
  it('sets stdio: "inherit" when detach is false', () => {
    launchAltergoAccount('/usr/bin/altergo', 'alice', undefined, { detach: false });
    const [, , opts] = spawnMock.mock.calls[0] as unknown as [string, string[], { stdio: string }];
    expect(opts.stdio).toBe('inherit');
  });

  it('does NOT call unref() in non-detach mode', () => {
    launchAltergoAccount('/usr/bin/altergo', 'alice', undefined, { detach: false });
    expect(mockChildUnref).not.toHaveBeenCalled();
  });

  it('fires the onExit callback with the exit code when the child exits', () => {
    const onExit = vi.fn();
    launchAltergoAccount('/usr/bin/altergo', 'alice', undefined, { detach: false, onExit });

    // Simulate the child process firing its 'exit' event
    const [event, handler] = mockChildOn.mock.calls[0] as [
      string,
      (code: number | null) => void,
    ];
    expect(event).toBe('exit');
    handler(0);
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('passes 0 to onExit when the child exits with a null code', () => {
    const onExit = vi.fn();
    launchAltergoAccount('/usr/bin/altergo', 'alice', undefined, { detach: false, onExit });
    const [, handler] = mockChildOn.mock.calls[0] as [string, (code: number | null) => void];
    handler(null);
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('fires onExit with nonzero exit code on failure', () => {
    const onExit = vi.fn();
    launchAltergoAccount('/usr/bin/altergo', 'alice', undefined, { detach: false, onExit });
    const [, handler] = mockChildOn.mock.calls[0] as [string, (code: number | null) => void];
    handler(1);
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('does not register an on-exit listener when onExit is not supplied', () => {
    launchAltergoAccount('/usr/bin/altergo', 'alice', undefined, { detach: false });
    expect(mockChildOn).not.toHaveBeenCalled();
  });
});

// ─── sanitiseEnv — secrets stripping ─────────────────────────────────────────

describe('launchAltergoAccount — sanitiseEnv: secret stripping', () => {
  const secretVars: Array<[string, string]> = [
    ['ANTHROPIC_API_KEY', 'sk-ant-abc'],
    ['OPENAI_API_KEY', 'sk-openai-abc'],
    ['GITHUB_TOKEN', 'ghp_abc'],
    ['GEMINI_API_KEY', 'AIza-abc'],
    ['COHERE_API_KEY', 'cohere-abc'],
    ['AWS_ACCESS_KEY_ID', 'AKIA-abc'],
    ['AWS_SECRET_ACCESS_KEY', 'secret-abc'],
    ['GCP_SERVICE_ACCOUNT_KEY', 'gcp-abc'],
    ['AZURE_CLIENT_SECRET', 'azure-abc'],
    ['MY_API_KEY', 'mykey-abc'],
    ['MY_TOKEN', 'tok-abc'],
    ['MY_SECRET', 'secret-abc'],
    ['MY_PASSWORD', 'pass-abc'],
    ['MY_CREDENTIAL', 'cred-abc'],
    ['HF_TOKEN', 'hf-abc'],
    ['HUGGINGFACE_API_KEY', 'hf2-abc'],
    ['GH_TOKEN', 'gh-abc'],
  ];

  it.each(secretVars)('strips %s from the child environment', (varName, varValue) => {
    process.env[varName] = varValue;
    launchAltergoAccount('/usr/bin/altergo', 'alice');
    const env = spawnEnvArg();
    expect(env).not.toHaveProperty(varName);
  });

  it('strips all UPLNK_* internal variables', () => {
    process.env['UPLNK_CONFIG_PATH'] = '/some/path';
    process.env['UPLNK_DEBUG'] = '1';
    process.env['UPLNK_LOG_LEVEL'] = 'verbose';
    launchAltergoAccount('/usr/bin/altergo', 'alice');
    const env = spawnEnvArg();
    expect(env).not.toHaveProperty('UPLNK_CONFIG_PATH');
    expect(env).not.toHaveProperty('UPLNK_DEBUG');
    expect(env).not.toHaveProperty('UPLNK_LOG_LEVEL');
  });
});

// ─── sanitiseEnv — infrastructure vars preserved ─────────────────────────────

describe('launchAltergoAccount — sanitiseEnv: infrastructure vars preserved', () => {
  const infraVars: Array<[string, string]> = [
    ['PATH', '/usr/bin:/bin'],
    ['HOME', '/home/user'],
    ['USER', 'alice'],
    ['TERM', 'xterm-256color'],
    ['LANG', 'en_US.UTF-8'],
    ['SHELL', '/bin/zsh'],
    ['TMPDIR', '/tmp'],
  ];

  it.each(infraVars)('preserves %s in the child environment', (varName, value) => {
    process.env[varName] = value;
    launchAltergoAccount('/usr/bin/altergo', 'alice');
    const env = spawnEnvArg();
    expect(env[varName]).toBe(value);
  });

  it('preserves LC_* locale variables', () => {
    process.env['LC_ALL'] = 'en_US.UTF-8';
    process.env['LC_CTYPE'] = 'en_US.UTF-8';
    launchAltergoAccount('/usr/bin/altergo', 'alice');
    const env = spawnEnvArg();
    expect(env['LC_ALL']).toBe('en_US.UTF-8');
    expect(env['LC_CTYPE']).toBe('en_US.UTF-8');
  });

  it('passes a sanitised env object (not process.env itself) to spawn', () => {
    launchAltergoAccount('/usr/bin/altergo', 'alice');
    const env = spawnEnvArg();
    expect(env).not.toBe(process.env);
  });
});

// ─── sanitiseEnv — pattern matching breadth ──────────────────────────────────

describe('launchAltergoAccount — sanitiseEnv: pattern matching coverage', () => {
  it('strips a lowercase api_key variable', () => {
    process.env['my_api_key'] = 'should-be-stripped';
    launchAltergoAccount('/usr/bin/altergo', 'alice');
    expect(spawnEnvArg()).not.toHaveProperty('my_api_key');
  });

  it('strips a variable with token in the middle of the name', () => {
    process.env['AUTH_TOKEN_VALUE'] = 'tok123';
    launchAltergoAccount('/usr/bin/altergo', 'alice');
    expect(spawnEnvArg()).not.toHaveProperty('AUTH_TOKEN_VALUE');
  });

  it('strips a variable with secret in the name', () => {
    process.env['APP_SECRET_KEY'] = 'sec123';
    launchAltergoAccount('/usr/bin/altergo', 'alice');
    expect(spawnEnvArg()).not.toHaveProperty('APP_SECRET_KEY');
  });

  it('strips a variable with password in the name', () => {
    process.env['DB_PASSWORD'] = 'hunter2';
    launchAltergoAccount('/usr/bin/altergo', 'alice');
    expect(spawnEnvArg()).not.toHaveProperty('DB_PASSWORD');
  });

  it('strips a variable with credential in the name', () => {
    process.env['SERVICE_CREDENTIAL'] = 'cred-value';
    launchAltergoAccount('/usr/bin/altergo', 'alice');
    expect(spawnEnvArg()).not.toHaveProperty('SERVICE_CREDENTIAL');
  });
});
