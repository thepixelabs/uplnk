/**
 * flow.test.ts
 *
 * Unit tests for runFlowCommand().
 *
 * We write real flow YAML/JSON to a temporary directory and point the config
 * at it, so we exercise the full load → parse → validate → (stub) run pipeline
 * without a running AI or the real config file.
 *
 * IMPORTANT: process.exit() does not halt execution when mocked to return
 * undefined.  For every code path that calls process.exit() we install a
 * throwing spy so control flow stops at the exit call, matching what would
 * happen in production.  Tests catch ProcessExitError to make assertions.
 *
 * Behaviours covered:
 *   list     — no dir, empty dir, valid + invalid flows in a table, JSON flows
 *   run      — flow found exits code 2 (not-yet-implemented stub)
 *            — flow not found exits code 1
 *            — missing name exits code 1
 *            — invalid flow schema exits code 1
 *   validate — valid flow reports success
 *            — invalid schema exits code 1
 *            — YAML parse error exits code 1
 *            — missing name exits code 1
 *            — flow not in dir exits code 1
 *            — missing flows dir exits code 1
 *   unknown action exits code 1
 *   config error exits code 1
 *   schema import: flow.ts imports FlowDef from flow/schema.ts (verified by
 *     testing that apiVersion is required — only the canonical schema enforces this)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spyOnProcess } from '../../../__tests__/helpers/processSpy.js';
import { createTmpFlowDir, MINIMAL_VALID_FLOW_YAML } from '../../../__tests__/helpers/tmpFlowDir.js';
import type { TmpFlowDir } from '../../../__tests__/helpers/tmpFlowDir.js';

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

vi.mock('../../../lib/config.js', () => ({
  getOrCreateConfig: vi.fn(() => ({
    ok: true,
    config: {
      headless: { persist: false },
      flows: { dir: '/tmp/default-flows-dir' },
    },
  })),
}));

// ── Static imports (after mocks) ──────────────────────────────────────────────

import { getOrCreateConfig } from '../../../lib/config.js';
import { runFlowCommand } from '../flow.js';

const mockGetOrCreateConfig = vi.mocked(getOrCreateConfig);

// ── Sentinel error class ──────────────────────────────────────────────────────

class ProcessExitError extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
    this.name = 'ProcessExitError';
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Minimal valid flow YAML with a description field for richer assertions */
const FLOW_WITH_DESCRIPTION = `apiVersion: uplnk.io/v1
name: my-flow
description: A test flow
steps:
  - id: step1
    type: chat
    prompt: "Say hello"
`;

/** Flow with an invalid name (uppercase violates the schema regex) */
const INVALID_NAME_YAML = `apiVersion: uplnk.io/v1
name: MyFlow
steps:
  - id: step1
    type: chat
    prompt: "hi"
`;

/** Completely broken YAML */
const BAD_YAML = `apiVersion: uplnk.io/v1
name: ][broken[
  bad: : yaml
`;

const VALID_FLOW_JSON = JSON.stringify({
  apiVersion: 'uplnk.io/v1',
  name: 'json-flow',
  steps: [{ id: 'step1', type: 'chat', prompt: 'hello from JSON' }],
});

// ── Setup / teardown ──────────────────────────────────────────────────────────

let tmpDir: TmpFlowDir;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = createTmpFlowDir();
});

afterEach(() => {
  tmpDir.cleanup();
});

/** Helper: configure the mock config to point at our temp dir */
function useFlowsDir(dir: string) {
  mockGetOrCreateConfig.mockReturnValue({
    ok: true,
    config: {
      headless: { persist: false },
      flows: { dir },
    },
  } as unknown as ReturnType<typeof getOrCreateConfig>);
}

/**
 * Run a flow command expecting process.exit() to be called.
 * Returns the exit code and the captured stderr/stdout.
 */
async function runExpectingExit(options: Parameters<typeof runFlowCommand>[0]) {
  const spy = spyOnProcess();
  spy.exit.mockImplementation((code) => {
    throw new ProcessExitError(code as number);
  });

  let caught: ProcessExitError | undefined;
  try {
    await runFlowCommand(options);
  } catch (e) {
    if (e instanceof ProcessExitError) caught = e;
    else throw e;
  }

  const stdout = spy.getStdout();
  const stderr = spy.getStderr();
  spy.restore();

  return { exitCode: caught?.code, stdout, stderr };
}

// ── list action ───────────────────────────────────────────────────────────────

describe('runFlowCommand — list', () => {
  it('prints a notice when the flows directory does not exist', async () => {
    useFlowsDir('/tmp/uplnk-no-such-dir-' + Date.now().toString());

    const spy = spyOnProcess();
    await runFlowCommand({ action: 'list' });
    const out = spy.getStdout();
    spy.restore();

    expect(out).toContain('No flows directory');
    expect(spy.exit).not.toHaveBeenCalled();
  });

  it('prints a notice when the flows directory exists but contains no flow files', async () => {
    useFlowsDir(tmpDir.dir);

    const spy = spyOnProcess();
    await runFlowCommand({ action: 'list' });
    const out = spy.getStdout();
    spy.restore();

    expect(out).toContain('No flows found');
  });

  it('prints a table row for each valid flow file', async () => {
    tmpDir.writeYaml('my-flow', FLOW_WITH_DESCRIPTION);
    useFlowsDir(tmpDir.dir);

    const spy = spyOnProcess();
    await runFlowCommand({ action: 'list' });
    const out = spy.getStdout();
    spy.restore();

    expect(out).toContain('my-flow');
    expect(out).toContain('valid');
  });

  it('marks a flow with an invalid schema as error in the table', async () => {
    tmpDir.writeYaml('bad-flow', INVALID_NAME_YAML);
    useFlowsDir(tmpDir.dir);

    const spy = spyOnProcess();
    await runFlowCommand({ action: 'list' });
    const out = spy.getStdout();
    spy.restore();

    expect(out).toContain('error');
  });

  it('handles JSON flow files alongside YAML files', async () => {
    tmpDir.writeJson('json-flow', JSON.parse(VALID_FLOW_JSON) as object);
    useFlowsDir(tmpDir.dir);

    const spy = spyOnProcess();
    await runFlowCommand({ action: 'list' });
    const out = spy.getStdout();
    spy.restore();

    expect(out).toContain('json-flow');
    expect(out).toContain('valid');
  });
});

// ── run action ────────────────────────────────────────────────────────────────

describe('runFlowCommand — run', () => {
  it('exits with code 2 (not-yet-implemented stub) when a valid flow is found', async () => {
    tmpDir.writeYaml('my-flow', FLOW_WITH_DESCRIPTION);
    useFlowsDir(tmpDir.dir);

    const { exitCode, stdout, stderr } = await runExpectingExit({ action: 'run', name: 'my-flow' });

    expect(exitCode).toBe(2);
    expect(stdout).toContain("Flow 'my-flow' loaded");
    expect(stdout).toContain('1 step(s)');
    expect(stderr).toContain('not yet available');
  });

  it('prints the flow description when the flow has one', async () => {
    tmpDir.writeYaml('my-flow', FLOW_WITH_DESCRIPTION);
    useFlowsDir(tmpDir.dir);

    const { stdout } = await runExpectingExit({ action: 'run', name: 'my-flow' });

    expect(stdout).toContain('A test flow');
  });

  it('exits with code 1 when the named flow does not exist', async () => {
    useFlowsDir(tmpDir.dir);

    const { exitCode, stderr } = await runExpectingExit({ action: 'run', name: 'no-such-flow' });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("no flow named 'no-such-flow'");
  });

  it('exits with code 1 when name is omitted', async () => {
    useFlowsDir(tmpDir.dir);

    const { exitCode, stderr } = await runExpectingExit({ action: 'run' });

    expect(exitCode).toBe(1);
    expect(stderr).toContain('a flow name is required');
  });

  it('exits with code 1 when the found flow fails schema validation', async () => {
    tmpDir.writeYaml('myflow', INVALID_NAME_YAML);
    useFlowsDir(tmpDir.dir);

    const { exitCode, stderr } = await runExpectingExit({ action: 'run', name: 'myflow' });

    expect(exitCode).toBe(1);
    expect(stderr).toContain('invalid flow');
  });
});

// ── validate action ───────────────────────────────────────────────────────────

describe('runFlowCommand — validate', () => {
  it('reports success and exits cleanly for a valid flow', async () => {
    tmpDir.writeYaml('my-flow', FLOW_WITH_DESCRIPTION);
    useFlowsDir(tmpDir.dir);

    const spy = spyOnProcess();
    await runFlowCommand({ action: 'validate', name: 'my-flow' });
    const stdout = spy.getStdout();
    spy.restore();

    expect(spy.exit).not.toHaveBeenCalled();
    expect(stdout).toContain("Flow 'my-flow' is valid");
    expect(stdout).toContain('steps: 1');
  });

  it('exits with code 1 for a flow with an invalid schema', async () => {
    tmpDir.writeYaml('bad', INVALID_NAME_YAML);
    useFlowsDir(tmpDir.dir);

    const { exitCode, stderr } = await runExpectingExit({ action: 'validate', name: 'bad' });

    expect(exitCode).toBe(1);
    expect(stderr).toContain('schema error');
  });

  it('exits with code 1 for a YAML parse error', async () => {
    tmpDir.writeYaml('broken', BAD_YAML);
    useFlowsDir(tmpDir.dir);

    const { exitCode, stderr } = await runExpectingExit({ action: 'validate', name: 'broken' });

    expect(exitCode).toBe(1);
    expect(stderr).toContain('parse error');
  });

  it('exits with code 1 when name is omitted', async () => {
    useFlowsDir(tmpDir.dir);

    const { exitCode, stderr } = await runExpectingExit({ action: 'validate' });

    expect(exitCode).toBe(1);
    expect(stderr).toContain('a flow name is required');
  });

  it('exits with code 1 when the flow name is not found in the directory', async () => {
    useFlowsDir(tmpDir.dir);

    const { exitCode, stderr } = await runExpectingExit({ action: 'validate', name: 'ghost' });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("no flow named 'ghost'");
  });

  it('exits with code 1 when the flows directory does not exist', async () => {
    useFlowsDir('/tmp/uplnk-no-such-dir-' + Date.now().toString());

    const { exitCode, stderr } = await runExpectingExit({ action: 'validate', name: 'any' });

    expect(exitCode).toBe(1);
    expect(stderr).toContain('flows directory not found');
  });
});

// ── unknown action ────────────────────────────────────────────────────────────

describe('runFlowCommand — unknown action', () => {
  it('exits with code 1 and lists valid actions', async () => {
    useFlowsDir(tmpDir.dir);

    const { exitCode, stderr } = await runExpectingExit({ action: 'explode' });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown action 'explode'");
    expect(stderr).toContain('list, run, validate');
  });
});

// ── config error ──────────────────────────────────────────────────────────────

describe('runFlowCommand — config error', () => {
  it('exits with code 1 when config validation fails', async () => {
    mockGetOrCreateConfig.mockReturnValueOnce({
      ok: false,
      error: 'version: Invalid literal value',
    } as unknown as ReturnType<typeof getOrCreateConfig>);

    const { exitCode, stderr } = await runExpectingExit({ action: 'list' });

    expect(exitCode).toBe(1);
    expect(stderr).toContain('config error');
  });
});

// ── schema import correctness ─────────────────────────────────────────────────

describe('runFlowCommand — FlowDef schema imported from flow/schema.ts', () => {
  it('rejects a flow missing apiVersion (only the canonical schema requires this field)', async () => {
    // A hypothetical "weak" local schema might only check name + steps.
    // The canonical flow/schema.ts also requires apiVersion: 'uplnk.io/v1'.
    // This test verifies flow.ts uses the canonical schema, not a weaker copy.
    const missingApiVersion = `name: my-flow\nsteps:\n  - id: step1\n    type: chat\n    prompt: hi\n`;

    tmpDir.writeYaml('no-api-version', missingApiVersion);
    useFlowsDir(tmpDir.dir);

    const { exitCode, stderr } = await runExpectingExit({ action: 'validate', name: 'no-api-version' });

    expect(exitCode).toBe(1);
    expect(stderr).toContain('schema error');
  });

  it('accepts the MINIMAL_VALID_FLOW_YAML from the project helper', async () => {
    // This double-checks that our fixture and the canonical schema agree.
    tmpDir.writeYaml('test-flow', MINIMAL_VALID_FLOW_YAML);
    useFlowsDir(tmpDir.dir);

    const spy = spyOnProcess();
    await runFlowCommand({ action: 'validate', name: 'test-flow' });
    const stdout = spy.getStdout();
    spy.restore();

    expect(spy.exit).not.toHaveBeenCalled();
    expect(stdout).toContain("is valid");
  });
});
