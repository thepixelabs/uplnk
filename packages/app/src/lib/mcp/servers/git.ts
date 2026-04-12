#!/usr/bin/env node
/**
 * uplnk-git — built-in stdio MCP server for git operations.
 *
 * Exposes four tools:
 *   mcp_git_status  — get repository status (read-only)
 *   mcp_git_diff    — show unified diff of changes (read-only)
 *   mcp_git_stage   — stage files for commit (write — requires approval)
 *   mcp_git_commit  — create a commit (write — requires approval)
 *
 * SECURITY NOTE: This server performs NO path validation and NO approval
 * gating. All security validation (repoPath checking against allowed roots)
 * and the human-in-the-loop approval gate for mutating operations (stage,
 * commit) are enforced by McpManager in the parent process BEFORE forwarding
 * the JSON-RPC call to this child (ref: ADR-004, arch-critical-fixes Phase 4).
 *
 * Running this server directly (outside McpManager) bypasses all security
 * controls — for test/debug purposes only.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

const server = new McpServer({
  name: 'uplnk-git',
  version: '0.1.0',
});

// ─── shared git runner ────────────────────────────────────────────────────────

/**
 * Run a git command in the given directory. Returns combined stdout+stderr.
 * Throws on non-zero exit — the error message includes stderr for diagnostics.
 */
async function runGit(repoPath: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync('git', ['-C', repoPath, ...args], {
    timeout: 15_000,       // 15s — diffs on large repos can take a moment
    maxBuffer: 1024 * 1024, // 1 MiB output limit
    // Minimal env — do not inherit parent process secrets
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: process.env['HOME'] ?? '/tmp',
      GIT_TERMINAL_PROMPT: '0', // never prompt for credentials
    },
    shell: false,
  });
  return [stdout, stderr].filter(Boolean).join('\n');
}

// ─── mcp_git_status ───────────────────────────────────────────────────────────

server.tool(
  'mcp_git_status',
  'Get the working-tree status for a git repository. ' +
  'Returns the same output as `git status`.',
  {
    repoPath: z.string().optional().describe(
      'Absolute path to the git repository root. Defaults to the current working directory.',
    ),
  },
  async ({ repoPath }: { repoPath?: string | undefined }) => {
    const cwd = repoPath ?? process.cwd();
    try {
      const output = await runGit(cwd, ['status']);
      return {
        content: [{ type: 'text' as const, text: output.length > 0 ? output : '(nothing to report)' }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `git status failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── mcp_git_diff ─────────────────────────────────────────────────────────────

server.tool(
  'mcp_git_diff',
  'Show a unified diff of changes in a git repository. ' +
  'Returns the same output as `git diff` (or `git diff --staged` for staged changes).',
  {
    repoPath: z.string().optional().describe(
      'Absolute path to the git repository root. Defaults to the current working directory.',
    ),
    staged: z.boolean().optional().describe(
      'When true, show staged (cached) changes instead of unstaged changes. Default: false.',
    ),
    filePath: z.string().optional().describe(
      'Limit the diff to a specific file or directory path.',
    ),
  },
  async ({ repoPath, staged, filePath }: { repoPath?: string | undefined; staged?: boolean | undefined; filePath?: string | undefined }) => {
    const cwd = repoPath ?? process.cwd();
    const doStaged = staged ?? false;

    const args: string[] = ['diff'];
    if (doStaged) args.push('--staged');
    if (filePath !== undefined) args.push('--', filePath);

    try {
      const output = await runGit(cwd, args);
      return {
        content: [{ type: 'text' as const, text: output.length > 0 ? output : '(no changes)' }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `git diff failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── mcp_git_stage ────────────────────────────────────────────────────────────

server.tool(
  'mcp_git_stage',
  'Stage one or more files for the next commit. ' +
  'Equivalent to `git add -- <paths>`. ' +
  'REQUIRES explicit user approval in the parent process before this is called.',
  {
    repoPath: z.string().optional().describe(
      'Absolute path to the git repository root. Defaults to the current working directory.',
    ),
    paths: z.array(z.string()).min(1).describe(
      'One or more file paths to stage (relative to repoPath or absolute).',
    ),
  },
  async ({ repoPath, paths }: { repoPath?: string | undefined; paths: string[] }) => {
    const cwd = repoPath ?? process.cwd();
    try {
      await runGit(cwd, ['add', '--', ...paths]);
      return {
        content: [{ type: 'text' as const, text: `Staged ${paths.length} file${paths.length !== 1 ? 's' : ''}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `git add failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── mcp_git_commit ───────────────────────────────────────────────────────────

server.tool(
  'mcp_git_commit',
  'Create a git commit with the given message using currently staged changes. ' +
  'Equivalent to `git commit -m <message>`. ' +
  'REQUIRES explicit user approval in the parent process before this is called.',
  {
    repoPath: z.string().optional().describe(
      'Absolute path to the git repository root. Defaults to the current working directory.',
    ),
    message: z.string().min(1).describe('The commit message.'),
  },
  async ({ repoPath, message }: { repoPath?: string | undefined; message: string }) => {
    const cwd = repoPath ?? process.cwd();
    try {
      const output = await runGit(cwd, ['commit', '-m', message]);
      // Extract short hash from output line like "[main abc1234] <message>"
      const hashMatch = /\[[\w/]+\s+([0-9a-f]+)\]/.exec(output);
      const shortHash = hashMatch?.[1] ?? 'unknown';
      return {
        content: [{ type: 'text' as const, text: `Created commit ${shortHash}: ${message}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `git commit failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
