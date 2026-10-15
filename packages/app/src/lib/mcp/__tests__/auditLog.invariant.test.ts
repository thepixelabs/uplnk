/**
 * Audit log content-leak invariant (Phase A item A.3.4).
 *
 * The AuditEntry shape carries an `args: Record<string, unknown>` field. By
 * convention (documented on AuditEntry in McpManager.ts) it may contain ONLY
 * structural metadata — paths, command basenames, boolean flags, byte/element
 * counts, UUIDs. It must NEVER carry file contents, command stdout/stderr,
 * tool output, secrets, or any user-content blob: the audit log itself can
 * be read by anyone with local FS access, so leaking content there defeats
 * the rest of the security layer.
 *
 * This test drives the real McpManager-wrapped built-in tools through their
 * approval/validation paths with realistic argument shapes (including a 10 KB
 * file body and a long command description) and inspects every AuditEntry
 * that lands in appendFileSync. The args object is walked recursively and the
 * invariant is asserted on every leaf value.
 *
 * If a future contributor accidentally drops file content (or stdout, or any
 * other large/sensitive blob) into the audit args, this test breaks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';

// ─── SDK mocks (must precede all imports that transitively load the SDK) ──────

const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockListTools = vi.fn();
const mockCallTool = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: vi.fn().mockImplementation(() => ({
      connect: mockConnect,
      close: mockClose,
      listTools: mockListTools,
      callTool: mockCallTool,
    })),
  };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: vi.fn().mockImplementation((opts: unknown) => ({ _opts: opts })),
  };
});

// ─── node:fs mock — capture appendFileSync to intercept audit log writes ─────

const mockAppendFileSync = vi.fn();
const mockStatSync = vi.fn();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    appendFileSync: (...args: unknown[]) => mockAppendFileSync(...args),
    statSync: (...args: unknown[]) => mockStatSync(...args),
    realpathSync: (p: string) => p, // identity — no real FS in unit tests
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
    existsSync: vi.fn(() => false),
    unlinkSync: vi.fn(),
  };
});

// ─── Subject under test (after mocks) ────────────────────────────────────────

import { McpManager } from '../McpManager.js';
import { createDefaultPolicy } from '../security.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from 'ai';

/**
 * Local restatement of the AuditEntry shape so the invariant is visible next
 * to the assertions. Source of truth lives in McpManager.ts.
 *
 * Invariant: every leaf inside `args` is structural metadata only. No content
 * blobs, no stdout/stderr, no secrets.
 */
interface AuditEntry {
  ts: string;
  tool: string;
  args: Record<string, unknown>;
  outcome: 'allowed' | 'denied' | 'error';
  detail?: string;
  conversationId?: string;
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

const ALLOWED_ROOT = '/projects/myapp';

/** Fields whose name alone is a strong signal a content blob was leaked. */
const FORBIDDEN_KEY_NAMES: ReadonlySet<string> = new Set([
  'content',
  'output',
  'result',
  'stdout',
  'stderr',
  'text',
  'body',
  'patch',
  'message', // git commit message — long free-form text, classified as content
]);

/**
 * Maximum length permitted for any string value inside an AuditEntry.args.
 * Structural fields (paths, command names, ISO timestamps, UUIDs) all fit well
 * under this. Anything longer is — by construction — content that shouldn't be
 * there.
 */
const MAX_ARG_STRING_LENGTH = 200;

function makeManager(opts: {
  commandExecEnabled?: boolean;
  gitEnabled?: boolean;
  approval?: ReturnType<typeof vi.fn>;
} = {}): McpManager {
  return new McpManager({
    filePolicy: createDefaultPolicy([ALLOWED_ROOT]),
    commandExecEnabled: opts.commandExecEnabled ?? false,
    gitEnabled: opts.gitEnabled ?? false,
    ragEnabled: false,
    requestApproval: opts.approval ?? vi.fn().mockResolvedValue(true),
  });
}

const FILE_BROWSE_TOOL_LIST = {
  tools: [
    {
      name: 'mcp_file_read',
      description: 'Read file contents.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    {
      name: 'mcp_file_write',
      description: 'Write file contents.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
    {
      name: 'mcp_file_patch',
      description: 'Apply unified diff.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, patch: { type: 'string' } },
        required: ['path', 'patch'],
      },
    },
  ],
};

const COMMAND_EXEC_TOOL_LIST = {
  tools: [
    {
      name: 'mcp_command_exec',
      description: 'Execute command.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          cwd: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['command'],
      },
    },
  ],
};

const GIT_TOOL_LIST = {
  tools: [
    {
      name: 'mcp_git_status',
      description: 'Git status.',
      inputSchema: { type: 'object', properties: { repoPath: { type: 'string' } } },
    },
    {
      name: 'mcp_git_diff',
      description: 'Git diff.',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          staged: { type: 'boolean' },
          filePath: { type: 'string' },
        },
      },
    },
    {
      name: 'mcp_git_commit',
      description: 'Git commit.',
      inputSchema: {
        type: 'object',
        properties: { repoPath: { type: 'string' }, message: { type: 'string' } },
        required: ['message'],
      },
    },
  ],
};

async function connectAndGetTools(
  mgr: McpManager,
  flags: { commandExecEnabled?: boolean; gitEnabled?: boolean } = {},
): Promise<Record<string, Tool>> {
  let chain = mockListTools.mockResolvedValueOnce(FILE_BROWSE_TOOL_LIST);
  if (flags.commandExecEnabled === true) {
    chain = chain.mockResolvedValueOnce(COMMAND_EXEC_TOOL_LIST);
  }
  if (flags.gitEnabled === true) {
    chain.mockResolvedValueOnce(GIT_TOOL_LIST);
  }
  await mgr.connectBuiltins();
  return mgr.getAiSdkToolsAsync();
}

/** All AuditEntry objects captured from appendFileSync since the last reset. */
function capturedEntries(): AuditEntry[] {
  return mockAppendFileSync.mock.calls.map((call) => {
    const line = call[1] as string;
    return JSON.parse(line.trim()) as AuditEntry;
  });
}

/**
 * Walk the args object recursively and assert no leaf violates the invariant.
 * Returns the list of violations found (empty when clean) so individual tests
 * can produce a useful failure message.
 */
function findInvariantViolations(
  value: unknown,
  path: string,
): Array<{ path: string; reason: string; preview: string }> {
  const violations: Array<{ path: string; reason: string; preview: string }> = [];

  if (typeof value === 'string') {
    if (value.length > MAX_ARG_STRING_LENGTH) {
      violations.push({
        path,
        reason: `string length ${value.length} > ${MAX_ARG_STRING_LENGTH}`,
        preview: value.slice(0, 60) + '…',
      });
    }
    return violations;
  }
  if (value === null || typeof value !== 'object') return violations;
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      violations.push(...findInvariantViolations(v, `${path}[${i}]`));
    }
    return violations;
  }

  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY_NAMES.has(k)) {
      violations.push({
        path: `${path}.${k}`,
        reason: `forbidden key name "${k}"`,
        preview: typeof v === 'string' ? v.slice(0, 60) + '…' : String(v).slice(0, 60),
      });
    }
    violations.push(...findInvariantViolations(v, `${path}.${k}`));
  }
  return violations;
}

function assertEntriesClean(entries: AuditEntry[]): void {
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    const violations = findInvariantViolations(entry.args, 'args');
    if (violations.length > 0) {
      const dump = JSON.stringify(entry.args, null, 2);
      const summary = violations
        .map((v) => `  ${v.path}: ${v.reason} — preview="${v.preview}"`)
        .join('\n');
      throw new Error(
        `Audit invariant violated on tool="${entry.tool}" outcome="${entry.outcome}":\n${summary}\n` +
          `Full args: ${dump}`,
      );
    }
  }
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('AuditEntry.args content-leak invariant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    // Default size-stat: well below any limit. Individual tests can override.
    mockStatSync.mockReturnValue({ size: 100 });
    // clearAllMocks() wipes the Client/Transport vi.fn() implementations set
    // in the vi.mock() factories — re-apply them so each test gets a fresh
    // working client.
    (Client as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      connect: mockConnect,
      close: mockClose,
      listTools: mockListTools,
      callTool: mockCallTool,
    }));
    (StdioClientTransport as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: unknown) => ({ _opts: opts }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mcp_file_write with a 10 KB body: AuditEntry.args contains byteLength, not content', async () => {
    const approval = vi.fn().mockResolvedValue(true);
    const mgr = makeManager({ approval });
    const tools = await connectAndGetTools(mgr);
    const tool = tools['mcp_file_write']!;

    const tenKB = 'A'.repeat(10 * 1024);
    await tool.execute!(
      { path: join(ALLOWED_ROOT, 'out.txt'), content: tenKB },
      { toolCallId: 'fw', messages: [] },
    );

    const entries = capturedEntries().filter((e) => e.tool === 'mcp_file_write');
    expect(entries.length).toBeGreaterThan(0);

    // Explicit structural check on the allowed entry: byteLength is recorded,
    // raw content is not.
    const allowed = entries.find((e) => e.outcome === 'allowed');
    expect(allowed).toBeDefined();
    expect(allowed!.args).toHaveProperty('byteLength');
    expect(allowed!.args['byteLength']).toBe(10 * 1024);
    expect(allowed!.args).not.toHaveProperty('content');

    assertEntriesClean(entries);
  });

  it('mcp_file_write denied at approval gate: denial entry still carries no content', async () => {
    const approval = vi.fn().mockResolvedValue(false);
    const mgr = makeManager({ approval });
    const tools = await connectAndGetTools(mgr);
    const tool = tools['mcp_file_write']!;

    await expect(
      tool.execute!(
        { path: join(ALLOWED_ROOT, 'out.txt'), content: 'B'.repeat(5000) },
        { toolCallId: 'fw-denied', messages: [] },
      ),
    ).rejects.toThrow();

    const entries = capturedEntries().filter((e) => e.tool === 'mcp_file_write');
    expect(entries.some((e) => e.outcome === 'denied')).toBe(true);
    assertEntriesClean(entries);
  });

  it('mcp_file_patch with a large patch body: AuditEntry.args carries only path and approvalId, not the patch', async () => {
    const approval = vi.fn().mockResolvedValue(true);
    const mgr = makeManager({ approval });
    const tools = await connectAndGetTools(mgr);
    const tool = tools['mcp_file_patch']!;

    // Build a unified diff body large enough that, if it ever leaked, the
    // 200-char string-length cap would catch it. Real-world patches routinely
    // exceed this.
    const fileTarget = join(ALLOWED_ROOT, 'src/main.ts');
    const bigPatch =
      `--- a/main.ts\n+++ b/main.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n` +
      Array.from({ length: 200 }, (_, i) => `+ added line ${i}`).join('\n');

    await tool.execute!(
      { path: fileTarget, patch: bigPatch },
      { toolCallId: 'fp', messages: [] },
    );

    const entries = capturedEntries().filter((e) => e.tool === 'mcp_file_patch');
    expect(entries.length).toBeGreaterThan(0);
    const allowed = entries.find((e) => e.outcome === 'allowed');
    expect(allowed).toBeDefined();
    expect(allowed!.args).not.toHaveProperty('patch');
    assertEntriesClean(entries);
  });

  it('mcp_command_exec with downstream stdout: AuditEntry.args records argCount, not the eventual stdout', async () => {
    const approval = vi.fn().mockResolvedValue(true);
    const mgr = makeManager({ commandExecEnabled: true, approval });
    const tools = await connectAndGetTools(mgr, { commandExecEnabled: true });
    const tool = tools['mcp_command_exec']!;

    // Simulate the child returning a large stdout block. The wrapper must
    // NOT capture this into the audit log — it's downstream of the audit
    // entry, but a future contributor might be tempted to "enrich" the entry
    // post-call. This test catches that.
    const fakeStdout = 'STDOUT-LINE: '.repeat(2000);
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: fakeStdout }],
    });

    await tool.execute!(
      { command: 'git', args: ['status', '--porcelain'], cwd: ALLOWED_ROOT },
      { toolCallId: 'ce', messages: [] },
    );

    const entries = capturedEntries().filter((e) => e.tool === 'mcp_command_exec');
    expect(entries.length).toBeGreaterThan(0);
    const allowed = entries.find((e) => e.outcome === 'allowed');
    expect(allowed).toBeDefined();
    expect(allowed!.args).toHaveProperty('argCount');
    expect(allowed!.args['argCount']).toBe(2);
    // Defensive: explicit checks for the call-site sensitive keys.
    expect(allowed!.args).not.toHaveProperty('args');
    expect(allowed!.args).not.toHaveProperty('stdout');
    expect(allowed!.args).not.toHaveProperty('output');
    assertEntriesClean(entries);
  });

  it('mcp_command_exec with a long human-readable description: description is NOT copied into args', async () => {
    const approval = vi.fn().mockResolvedValue(true);
    const mgr = makeManager({ commandExecEnabled: true, approval });
    const tools = await connectAndGetTools(mgr, { commandExecEnabled: true });
    const tool = tools['mcp_command_exec']!;

    // The description field is free-form text the model emits — it can be
    // arbitrarily long and may quote user input verbatim. It feeds the
    // approval dialog, but it must not bleed into the audit log.
    const longDescription =
      'This command will iterate over every file in the repository and ' +
      'print all matching lines. The user requested the following query: ' +
      'API_KEY=' + 'X'.repeat(500);

    await tool.execute!(
      {
        command: 'grep',
        args: ['-r', 'TODO'],
        cwd: ALLOWED_ROOT,
        description: longDescription,
      },
      { toolCallId: 'ce-desc', messages: [] },
    );

    const entries = capturedEntries().filter((e) => e.tool === 'mcp_command_exec');
    expect(entries.length).toBeGreaterThan(0);
    assertEntriesClean(entries);
  });

  it('mcp_git_status and mcp_git_diff with clean inputs: pass invariant cleanly', async () => {
    const approval = vi.fn().mockResolvedValue(true);
    const mgr = makeManager({ gitEnabled: true, approval });
    const tools = await connectAndGetTools(mgr, { gitEnabled: true });

    await tools['mcp_git_status']!.execute!(
      { repoPath: ALLOWED_ROOT },
      { toolCallId: 'gs', messages: [] },
    );

    await tools['mcp_git_diff']!.execute!(
      { repoPath: ALLOWED_ROOT, staged: false, filePath: join(ALLOWED_ROOT, 'src/foo.ts') },
      { toolCallId: 'gd', messages: [] },
    );

    const entries = capturedEntries().filter(
      (e) => e.tool === 'mcp_git_status' || e.tool === 'mcp_git_diff',
    );
    expect(entries).toHaveLength(2);
    assertEntriesClean(entries);
  });

  it('mcp_git_commit: commit message is NOT recorded in args (free-form text classified as content)', async () => {
    const approval = vi.fn().mockResolvedValue(true);
    const mgr = makeManager({ gitEnabled: true, approval });
    const tools = await connectAndGetTools(mgr, { gitEnabled: true });
    const tool = tools['mcp_git_commit']!;

    // A multi-paragraph commit message that, if leaked, would obviously
    // exceed the 200-char cap and trip the forbidden-key check (`message`).
    const message =
      'feat(api): integrate third-party SSO provider\n\n' +
      'This commit threads OAuth credentials through the auth layer. ' +
      'Refer to the design doc for the threat model and approved scopes. ' +
      'Includes test coverage for token refresh and revocation paths.';

    await tool.execute!(
      { repoPath: ALLOWED_ROOT, message },
      { toolCallId: 'gcm', messages: [] },
    );

    const entries = capturedEntries().filter((e) => e.tool === 'mcp_git_commit');
    expect(entries.length).toBeGreaterThan(0);
    const allowed = entries.find((e) => e.outcome === 'allowed');
    expect(allowed).toBeDefined();
    expect(allowed!.args).not.toHaveProperty('message');
    assertEntriesClean(entries);
  });

  it('helper sanity: findInvariantViolations flags a deliberately bad entry', () => {
    // Defensive — guard against false-negative tests by exercising the walker
    // on a synthetic entry that should fail.
    const bad: AuditEntry = {
      ts: '2026-01-01T00:00:00Z',
      tool: 'synthetic',
      args: {
        path: '/projects/myapp/x.ts',
        content: 'this is a leaked file body',
      },
      outcome: 'allowed',
    };
    const violations = findInvariantViolations(bad.args, 'args');
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.path.endsWith('.content'))).toBe(true);
  });

  it('helper sanity: long string nested inside an args sub-object is detected', () => {
    const bad = {
      meta: {
        echoed: 'Z'.repeat(MAX_ARG_STRING_LENGTH + 50),
      },
    };
    const violations = findInvariantViolations(bad, 'args');
    expect(violations.some((v) => v.reason.startsWith('string length'))).toBe(true);
  });
});
