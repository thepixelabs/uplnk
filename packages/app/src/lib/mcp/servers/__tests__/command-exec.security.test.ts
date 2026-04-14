/**
 * command-exec MCP server — security contract tests.
 *
 * The command-exec server is a thin stdio wrapper around node:child_process
 * execFile. Its security contract (ADR-004) is enforced at two layers:
 *
 *   1. Parent process (McpManager) runs validateCommand() which rejects any
 *      NEVER_ALLOW_COMMANDS, shell metacharacters, blocked arg patterns, etc.
 *      That layer is covered by src/lib/mcp/__tests__/security.test.ts.
 *
 *   2. This server itself must harden the actual child-process spawn so that
 *      even a parent-layer mistake cannot escalate privileges:
 *        - shell: false          (no shell expansion, ever)
 *        - timeout: 30_000       (30s wall-clock cap)
 *        - maxBuffer: 512 * 1024 (512 KiB output cap)
 *        - env: stripped         (no parent-process secrets leak to child)
 *
 * Additionally, layer-1 MUST reject every NEVER_ALLOW command regardless of
 * what the caller passes in `additionalAllowed`. This file pins both layers.
 *
 * Test strategy
 * ─────────────
 * The command-exec server auto-connects to a StdioServerTransport at import
 * time. We mock the MCP SDK so the connect() call is a no-op and we capture
 * the tool callback via a McpServer.prototype.tool() spy — the same pattern
 * used by git.test.ts / file-browse-write.test.ts.
 *
 * We then mock node:child_process.execFile so invoking the tool runs our spy
 * instead of a real binary, and we assert on the options object the server
 * passed through.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import {
  NEVER_ALLOW_COMMANDS,
  validateCommand,
  createDefaultPolicy,
} from '../../security.js';

const POLICY = createDefaultPolicy(['/tmp']);

// ─── Mock child_process BEFORE importing command-exec.ts ──────────────────────
//
// command-exec.ts calls `promisify(execFile)` at import time. `promisify`
// resolves its target eagerly, so we must mock execFile itself (not just its
// resolved promise) before the module-level code runs.

const childProcMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: childProcMocks.execFile,
  };
});

const mockExecFile = childProcMocks.execFile;

// ─── Mock the StdioServerTransport — no real stdio traffic ────────────────────

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
  })),
}));

// ─── Intercept McpServer.tool() to capture the command-exec callback ─────────

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

type ToolCallback = (args: {
  command: string;
  args?: string[] | undefined;
  cwd?: string | undefined;
}) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

const capturedTools = new Map<string, ToolCallback>();

beforeAll(async () => {
  vi.spyOn(McpServer.prototype, 'connect').mockResolvedValue(undefined);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (McpServer.prototype as any).tool = function (
    name: unknown,
    _descOrShape: unknown,
    _shapeOrCb: unknown,
    maybeCb?: unknown,
  ) {
    const cb = (maybeCb ?? _shapeOrCb) as ToolCallback;
    capturedTools.set(name as string, cb);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    return this;
  };

  // Import the server — module-level code registers `mcp_command_exec`.
  await import('../command-exec.js');
});

// ─── Test helpers ─────────────────────────────────────────────────────────────

/**
 * promisify(execFile) calls execFile with a trailing callback. Our mock
 * receives (cmd, args, options, cb) and delivers success synchronously.
 */
type ExecFileCb = (
  err: Error | null,
  result?: { stdout: string; stderr: string },
) => void;

function setupExecFileSuccess(stdout = 'ok', stderr = ''): void {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
      cb(null, { stdout, stderr });
    },
  );
}

async function callCommandExec(args: {
  command: string;
  args?: string[];
  cwd?: string;
}) {
  const handler = capturedTools.get('mcp_command_exec');
  if (!handler) throw new Error('mcp_command_exec was never registered');
  return handler(args);
}

/** Extract the options object passed to execFile (third positional arg). */
function lastExecFileOptions(): Record<string, unknown> {
  const calls = mockExecFile.mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error('execFile was not called');
  return last[2] as Record<string, unknown>;
}

// ─── Layer 1: validateCommand rejects every NEVER_ALLOW command ──────────────

describe('Layer 1 — validateCommand rejects NEVER_ALLOW commands', () => {
  it('has a non-empty NEVER_ALLOW list (sanity)', () => {
    expect(NEVER_ALLOW_COMMANDS.size).toBeGreaterThan(0);
  });

  it.each([...NEVER_ALLOW_COMMANDS])(
    'rejects %s regardless of additionalAllowed override',
    (cmdName) => {
      // Even if a misconfigured caller tries to permit it, validateCommand
      // must still deny. This is the "absolute precedence" rule from ADR-004.
      const result = validateCommand(
        { command: cmdName, args: [] },
        POLICY,
        [cmdName], // malicious attempt to allow it via override
      );

      expect(result.allowed).toBe(false);
      if (result.allowed === false) {
        expect(result.reason).toMatch(/permanently blocked|not in the allowed command list/i);
      }
    },
  );

  it('rejects an absolute path that resolves to a NEVER_ALLOW basename', () => {
    // /bin/bash should still be rejected — basename('sh') check fires.
    const result = validateCommand(
      { command: '/bin/bash', args: ['-c', 'echo hi'] },
      POLICY,
    );
    expect(result.allowed).toBe(false);
  });
});

// ─── Layer 2: command-exec spawn hardening ───────────────────────────────────

describe('Layer 2 — command-exec spawns children with hardened options', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    setupExecFileSuccess('hello\n');
  });

  it('passes shell:false to execFile (no shell expansion)', async () => {
    await callCommandExec({ command: 'echo', args: ['hi'] });

    const opts = lastExecFileOptions();
    expect(opts['shell']).toBe(false);
  });

  it('enforces a 30-second timeout cap', async () => {
    await callCommandExec({ command: 'sleep', args: ['1'] });

    const opts = lastExecFileOptions();
    expect(opts['timeout']).toBe(30_000);
  });

  it('enforces a 512 KiB maxBuffer cap', async () => {
    await callCommandExec({ command: 'cat', args: ['/tmp/foo'] });

    const opts = lastExecFileOptions();
    expect(opts['maxBuffer']).toBe(512 * 1024);
  });

  it('strips parent-process secrets from the child env', async () => {
    const secretKeys = [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'GITHUB_TOKEN',
      'NPM_TOKEN',
    ];

    // Plant fake secrets in parent env
    const originals: Array<[string, string | undefined]> = [];
    for (const k of secretKeys) {
      originals.push([k, process.env[k]]);
      process.env[k] = `FAKE-${k}-VALUE`;
    }

    try {
      await callCommandExec({ command: 'echo', args: ['hi'] });

      const opts = lastExecFileOptions();
      const childEnv = opts['env'] as Record<string, string>;

      // Sanity: the hardened env only exposes PATH/HOME/TMPDIR/TERM.
      expect(childEnv).toBeDefined();
      expect(Object.keys(childEnv).sort()).toEqual(
        ['HOME', 'PATH', 'TERM', 'TMPDIR'].sort(),
      );

      // None of the planted secrets are in the child env.
      for (const k of secretKeys) {
        expect(childEnv[k]).toBeUndefined();
      }

      // And — belt & braces — none of the FAKE-* values leaked under any key.
      for (const [, value] of Object.entries(childEnv)) {
        expect(value).not.toMatch(/^FAKE-/);
      }
    } finally {
      for (const [k, v] of originals) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('sets TERM=dumb in the child env (prevents terminal escape injection)', async () => {
    await callCommandExec({ command: 'echo', args: ['hi'] });

    const opts = lastExecFileOptions();
    const childEnv = opts['env'] as Record<string, string>;
    expect(childEnv['TERM']).toBe('dumb');
  });

  it('defaults cwd to process.cwd() when the caller does not supply one', async () => {
    await callCommandExec({ command: 'echo', args: ['hi'] });

    const opts = lastExecFileOptions();
    expect(opts['cwd']).toBe(process.cwd());
  });

  it('propagates caller-supplied cwd verbatim', async () => {
    await callCommandExec({ command: 'echo', args: ['hi'], cwd: '/tmp/work' });

    const opts = lastExecFileOptions();
    expect(opts['cwd']).toBe('/tmp/work');
  });

  it('returns isError:true when execFile yields an error', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
        cb(new Error('spawn failed: ENOENT'));
      },
    );

    const result = await callCommandExec({ command: 'does-not-exist' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Command failed');
  });
});
