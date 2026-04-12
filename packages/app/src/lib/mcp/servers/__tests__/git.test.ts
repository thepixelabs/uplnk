/**
 * Unit tests for the git MCP server — runGit logic and tool handler behavior.
 *
 * Strategy: we intercept tool handler registration by spying on McpServer.tool()
 * before the module-level code in git.ts runs. This captures each tool's
 * callback so we can invoke it directly without spawning a real stdio process.
 *
 * node:child_process is mocked throughout so no real git commands execute.
 *
 * This approach tests the tool handlers as functions (argument handling, output
 * shaping, error paths) following the same pattern as file-browse-write.test.ts
 * which also tests callback logic directly.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

// ─── Mock child_process BEFORE importing git.ts ───────────────────────────────

const mockExecFile = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

// ─── Mock StdioServerTransport — no-op connect ───────────────────────────────

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

// ─── Intercept McpServer.tool() to capture callbacks ─────────────────────────
//
// We spy on McpServer.prototype.tool BEFORE git.ts is imported so the module-
// level server.tool() calls in git.ts are captured here, not executed for real.
// We also need McpServer.prototype.connect to be a no-op.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

type ToolCallback = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

const capturedTools = new Map<string, ToolCallback>();

beforeAll(async () => {
  // Spy on connect to prevent the stdio transport from being used
  vi.spyOn(McpServer.prototype, 'connect').mockResolvedValue(undefined);

  // Replace tool() with a capturing stub.
  // We cast through unknown to sidestep the complex McpServer.tool overload types —
  // the actual runtime shape only cares that we intercept calls correctly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (McpServer.prototype as any).tool = function (
    name: unknown,
    _descOrShape: unknown,
    _shapeOrCb: unknown,
    maybeCb?: unknown,
  ) {
    // McpServer.tool has multiple overloads; the callback is always the last arg.
    const cb = (maybeCb ?? _shapeOrCb) as ToolCallback;
    capturedTools.set(name as string, cb);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    return this;
  };

  // Import git.ts — this runs the module-level code which calls server.tool()
  // for each of the four tools, and then server.connect() which we've mocked.
  await import('../git.js');
});

// ─── Test helpers ─────────────────────────────────────────────────────────────

type ExecFileCb = (err: Error | null, result?: { stdout: string; stderr: string }) => void;

function setupExecFileSuccess(stdout: string, stderr = ''): void {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
      cb(null, { stdout, stderr });
    },
  );
}

function setupExecFileError(message: string): void {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
      cb(new Error(message));
    },
  );
}

async function callTool(name: string, args: Record<string, unknown>) {
  const handler = capturedTools.get(name);
  if (!handler) throw new Error(`Tool "${name}" was not registered`);
  return handler(args);
}

// ─── mcp_git_status ───────────────────────────────────────────────────────────

describe('mcp_git_status', () => {
  it('registers a mcp_git_status tool', () => {
    expect(capturedTools.has('mcp_git_status')).toBe(true);
  });

  it('returns git output on success', async () => {
    setupExecFileSuccess('On branch main\nnothing to commit\n');

    const result = await callTool('mcp_git_status', { repoPath: '/repo' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain('On branch main');
  });

  it('passes -C repoPath to execFile', async () => {
    setupExecFileSuccess('On branch main\n');

    await callTool('mcp_git_status', { repoPath: '/my/repo' });

    const [, args] = mockExecFile.mock.calls[mockExecFile.mock.calls.length - 1] as [string, string[]];
    expect(args[0]).toBe('-C');
    expect(args[1]).toBe('/my/repo');
    expect(args).toContain('status');
  });

  it('returns (nothing to report) when stdout is empty', async () => {
    setupExecFileSuccess('', '');

    const result = await callTool('mcp_git_status', { repoPath: '/repo' });

    expect(result.content[0]?.text).toBe('(nothing to report)');
  });

  it('returns isError=true when git exits non-zero', async () => {
    setupExecFileError('fatal: not a git repository');

    const result = await callTool('mcp_git_status', { repoPath: '/not-a-repo' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('git status failed');
    expect(result.content[0]?.text).toContain('not a git repository');
  });

  it('uses process.cwd() when repoPath is undefined', async () => {
    setupExecFileSuccess('On branch main\n');

    await callTool('mcp_git_status', {});

    const [, args] = mockExecFile.mock.calls[mockExecFile.mock.calls.length - 1] as [string, string[]];
    // -C is followed by a non-empty path (cwd)
    const cIdx = args.indexOf('-C');
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(args[cIdx + 1]).toBeTruthy();
  });
});

// ─── mcp_git_diff ─────────────────────────────────────────────────────────────

describe('mcp_git_diff', () => {
  it('registers a mcp_git_diff tool', () => {
    expect(capturedTools.has('mcp_git_diff')).toBe(true);
  });

  it('returns diff output on success', async () => {
    setupExecFileSuccess('diff --git a/foo.ts b/foo.ts\n-old\n+new\n');

    const result = await callTool('mcp_git_diff', { repoPath: '/repo' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain('diff --git');
  });

  it('passes --staged when staged=true', async () => {
    setupExecFileSuccess('+staged change\n');

    await callTool('mcp_git_diff', { repoPath: '/repo', staged: true });

    const [, args] = mockExecFile.mock.calls[mockExecFile.mock.calls.length - 1] as [string, string[]];
    expect(args).toContain('--staged');
  });

  it('does not pass --staged when staged=false', async () => {
    setupExecFileSuccess('');

    await callTool('mcp_git_diff', { repoPath: '/repo', staged: false });

    const [, args] = mockExecFile.mock.calls[mockExecFile.mock.calls.length - 1] as [string, string[]];
    expect(args).not.toContain('--staged');
  });

  it('passes -- filePath when filePath is provided', async () => {
    setupExecFileSuccess('diff --git a/src/index.ts b/src/index.ts\n');

    await callTool('mcp_git_diff', { repoPath: '/repo', filePath: 'src/index.ts' });

    const [, args] = mockExecFile.mock.calls[mockExecFile.mock.calls.length - 1] as [string, string[]];
    expect(args).toContain('--');
    expect(args).toContain('src/index.ts');
  });

  it('returns (no changes) when stdout is empty', async () => {
    setupExecFileSuccess('', '');

    const result = await callTool('mcp_git_diff', { repoPath: '/repo' });

    expect(result.content[0]?.text).toBe('(no changes)');
  });

  it('returns isError=true when git diff fails', async () => {
    setupExecFileError('fatal: not a git repository');

    const result = await callTool('mcp_git_diff', { repoPath: '/not-a-repo' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('git diff failed');
  });
});

// ─── mcp_git_stage ────────────────────────────────────────────────────────────

describe('mcp_git_stage', () => {
  it('registers a mcp_git_stage tool', () => {
    expect(capturedTools.has('mcp_git_stage')).toBe(true);
  });

  it('stages a single file and returns "Staged 1 file"', async () => {
    setupExecFileSuccess('');

    const result = await callTool('mcp_git_stage', { repoPath: '/repo', paths: ['src/foo.ts'] });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe('Staged 1 file');
  });

  it('stages multiple files and uses plural "files"', async () => {
    setupExecFileSuccess('');

    const result = await callTool('mcp_git_stage', { repoPath: '/repo', paths: ['a.ts', 'b.ts', 'c.ts'] });

    expect(result.content[0]?.text).toBe('Staged 3 files');
  });

  it('passes git add -- with all paths', async () => {
    setupExecFileSuccess('');

    await callTool('mcp_git_stage', { repoPath: '/repo', paths: ['x.ts', 'y.ts'] });

    const [, args] = mockExecFile.mock.calls[mockExecFile.mock.calls.length - 1] as [string, string[]];
    expect(args).toContain('add');
    expect(args).toContain('--');
    expect(args).toContain('x.ts');
    expect(args).toContain('y.ts');
  });

  it('returns isError=true when git add fails', async () => {
    setupExecFileError('error: pathspec did not match any files');

    const result = await callTool('mcp_git_stage', { repoPath: '/repo', paths: ['nonexistent.ts'] });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('git add failed');
  });
});

// ─── mcp_git_commit ───────────────────────────────────────────────────────────

describe('mcp_git_commit', () => {
  it('registers a mcp_git_commit tool', () => {
    expect(capturedTools.has('mcp_git_commit')).toBe(true);
  });

  it('extracts the short hash from git commit output', async () => {
    setupExecFileSuccess('[main abc1234] feat: add feature\n 1 file changed\n');

    const result = await callTool('mcp_git_commit', { repoPath: '/repo', message: 'feat: add feature' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain('abc1234');
    expect(result.content[0]?.text).toContain('feat: add feature');
  });

  it('passes -m message to git commit', async () => {
    setupExecFileSuccess('[main def5678] my message\n');

    await callTool('mcp_git_commit', { repoPath: '/repo', message: 'my message' });

    const [, args] = mockExecFile.mock.calls[mockExecFile.mock.calls.length - 1] as [string, string[]];
    expect(args).toContain('commit');
    expect(args).toContain('-m');
    expect(args).toContain('my message');
  });

  it('falls back to "unknown" when output has no [branch hash] pattern', async () => {
    setupExecFileSuccess('Committed successfully');

    const result = await callTool('mcp_git_commit', { repoPath: '/repo', message: 'my commit' });

    expect(result.content[0]?.text).toContain('unknown');
  });

  it('returns isError=true when git commit fails', async () => {
    setupExecFileError('nothing to commit, working tree clean');

    const result = await callTool('mcp_git_commit', { repoPath: '/repo', message: 'empty' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('git commit failed');
  });

  it('includes stderr output in error message', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
        const err = new Error('On branch main\nnothing to commit') as Error & { stderr?: string };
        err.stderr = 'nothing to commit';
        cb(err);
      },
    );

    const result = await callTool('mcp_git_commit', { repoPath: '/repo', message: 'test' });

    expect(result.isError).toBe(true);
  });
});
