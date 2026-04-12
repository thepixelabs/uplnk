#!/usr/bin/env node
/**
 * pylon-command-exec — built-in stdio MCP server for shell command execution.
 *
 * Exposes one tool:
 *   mcp_command_exec — execute a shell command and return its output
 *
 * SECURITY NOTE: This server performs NO security validation and NO approval
 * gating. All validation (blocked-command patterns, cwd checking) and the
 * human-in-the-loop approval gate are enforced by McpManager in the parent
 * process BEFORE forwarding the JSON-RPC call to this child (ref: ADR-004,
 * arch-critical-fixes Phase 4).
 *
 * Running this server directly (outside McpManager) bypasses all security
 * controls — for test/debug purposes only.
 *
 * This server is only spawned when config.mcp.commandExecEnabled = true.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

const server = new McpServer({
  name: 'pylon-command-exec',
  version: '0.1.0',
});

// ─── mcp_command_exec ─────────────────────────────────────────────────────────

server.tool(
  'mcp_command_exec',
  'Execute a shell command and return its combined stdout/stderr output. ' +
  'REQUIRES explicit user approval in the parent process before this is called.',
  {
    command: z.string().describe('The command to execute (binary name, no shell expansion)'),
    args: z.array(z.string()).optional().describe('Command arguments'),
    cwd: z.string().optional().describe('Working directory'),
  },
  async ({ command, args, cwd }: { command: string; args?: string[] | undefined; cwd?: string | undefined }) => {
    const effectiveArgs = args ?? [];
    try {
      const { stdout, stderr } = await execFileAsync(command, effectiveArgs, {
        cwd: cwd ?? process.cwd(),
        timeout: 30_000,        // 30s hard timeout
        maxBuffer: 512 * 1024,  // 512 KB output limit
        // Minimal env — no inheriting parent process secrets
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          HOME: process.env['HOME'] ?? '/tmp',
          TMPDIR: process.env['TMPDIR'] ?? '/tmp',
          TERM: 'dumb',
        },
        shell: false, // CRITICAL: no shell expansion
      });

      const output = [stdout, stderr].filter(Boolean).join('\n');
      return {
        content: [{ type: 'text' as const, text: output.length > 0 ? output : '(command completed with no output)' }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Command failed: ${msg}` }],
        isError: true,
      };
    }
  },
);

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
