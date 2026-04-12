#!/usr/bin/env node
/**
 * uplnk-file-browse — built-in stdio MCP server for file access.
 *
 * Exposes two tools:
 *   mcp_file_read  — read a file's UTF-8 contents
 *   mcp_file_list  — list directory entries
 *
 * SECURITY NOTE: This server performs NO path validation. All security
 * validation (allowed-path checking, size limits, blocked-pattern matching)
 * is done by McpManager in the parent process BEFORE forwarding the
 * JSON-RPC call to this child. The parent wraps every tool execute() with
 * a pre-call validation hook (ref: arch-critical-fixes Phase 4, ADR-004).
 *
 * Running this server directly (outside McpManager) bypasses all security
 * controls — for test/debug purposes only.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { z } from 'zod';

const server = new McpServer({
  name: 'uplnk-file-browse',
  version: '0.1.0',
});

// ─── mcp_file_read ────────────────────────────────────────────────────────────

server.tool(
  'mcp_file_read',
  'Read the UTF-8 contents of a file at the given path.',
  {
    path: z.string().describe('Absolute path to the file to read'),
  },
  async ({ path }: { path: string }) => {
    try {
      const contents = readFileSync(path, 'utf-8');
      return {
        content: [{ type: 'text' as const, text: contents }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading file: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── mcp_file_list ────────────────────────────────────────────────────────────

server.tool(
  'mcp_file_list',
  'List files and directories at a path.',
  {
    path: z.string().describe('Directory path to list'),
    recursive: z.boolean().optional().describe('Whether to list recursively (default: false)'),
    maxDepth: z.number().int().min(1).max(5).optional().describe('Maximum recursion depth (default: 3, max: 5)'),
  },
  async ({ path, recursive, maxDepth }: { path: string; recursive?: boolean | undefined; maxDepth?: number | undefined }) => {
    const doRecursive = recursive ?? false;
    const effectiveMaxDepth = Math.min(maxDepth ?? 3, 5);
    const MAX_ENTRIES = 500;
    const entries: string[] = [];

    function walk(dir: string, depth: number): void {
      if (depth > effectiveMaxDepth) return;
      if (entries.length >= MAX_ENTRIES) return;

      let items: string[];
      try {
        items = readdirSync(dir);
      } catch {
        return;
      }

      for (const item of items) {
        if (entries.length >= MAX_ENTRIES) break;
        if (item.startsWith('.')) continue; // skip hidden entries

        const fullPath = join(dir, item);
        const rel = relative(path, fullPath);

        try {
          const st = statSync(fullPath);
          if (st.isDirectory()) {
            entries.push(`${rel}/`);
            if (doRecursive) walk(fullPath, depth + 1);
          } else {
            const sizeKb = Math.ceil(st.size / 1024);
            entries.push(`${rel}  (${sizeKb} KB)`);
          }
        } catch {
          // skip unreadable entries
        }
      }
    }

    try {
      walk(path, 0);
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error listing directory: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }

    const truncated = entries.length >= MAX_ENTRIES;
    if (truncated) {
      entries.push(`... (truncated at ${MAX_ENTRIES} entries)`);
    }

    const output = entries.length > 0 ? entries.join('\n') : '(empty directory)';
    return {
      content: [{ type: 'text' as const, text: output }],
    };
  },
);

// ─── mcp_file_write ───────────────────────────────────────────────────────────

server.tool(
  'mcp_file_write',
  'Write UTF-8 content to a file, optionally creating parent directories.',
  {
    path: z.string().describe('Absolute path to the file to write'),
    content: z.string().describe('UTF-8 content to write'),
    createDirs: z.boolean().optional().describe('Create parent directories if they do not exist (default: false)'),
  },
  async ({ path, content, createDirs }: { path: string; content: string; createDirs?: boolean | undefined }) => {
    try {
      const doCreate = createDirs ?? false;
      if (doCreate) {
        mkdirSync(dirname(path), { recursive: true });
      }
      writeFileSync(path, content, 'utf-8');
      return {
        content: [{ type: 'text' as const, text: `Written ${Buffer.byteLength(content, 'utf-8')} bytes to ${path}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error writing file: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── mcp_file_patch ───────────────────────────────────────────────────────────

/**
 * Parse and apply a unified diff patch to a string of file content.
 *
 * Supported format:
 *   --- a/...
 *   +++ b/...
 *   @@ -L,N +L,N @@
 *   [context/remove/add lines]
 *
 * Returns the patched content string, or throws an Error describing why the
 * patch could not be applied cleanly.
 *
 * Exported for unit testing.
 */
export function applyUnifiedDiff(original: string, patch: string): string {
  const patchLines = patch.split('\n');
  // Split preserving trailing newline state
  const originalLines = original.split('\n');

  // Skip header lines (--- / +++ / diff --git / index etc.)
  let i = 0;
  while (i < patchLines.length && !patchLines[i]!.startsWith('@@')) {
    i++;
  }

  if (i >= patchLines.length) {
    throw new Error('No hunks found in patch (no @@ markers).');
  }

  // Work on a mutable copy of the original lines
  const result = [...originalLines];
  // offset tracks how many lines we've added/removed so far (maps original
  // line numbers to result line numbers)
  let lineOffset = 0;

  while (i < patchLines.length) {
    const hunkHeader = patchLines[i]!;
    if (!hunkHeader.startsWith('@@')) {
      // skip non-hunk lines between hunks (e.g. trailing diff context)
      i++;
      continue;
    }

    // Parse @@ -L,N +L,N @@ ...
    // The comma and count are optional: @@ -1 +1 @@ is valid (N defaults to 1)
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunkHeader);
    if (!match) {
      throw new Error(`Malformed hunk header: ${hunkHeader}`);
    }

    const origStart = parseInt(match[1]!, 10);
    const origCount = match[2] !== undefined ? parseInt(match[2]!, 10) : 1;
    i++; // move past the @@ line

    // Collect hunk body lines
    const hunkBody: string[] = [];
    while (i < patchLines.length && !patchLines[i]!.startsWith('@@')) {
      // Stop at next hunk header or end of patch
      // But also skip "\ No newline at end of file" markers
      if (!patchLines[i]!.startsWith('\\')) {
        hunkBody.push(patchLines[i]!);
      }
      i++;
    }

    // Verify the context and removal lines match the original content
    // origStart is 1-based; result array is 0-based
    const resultStart = origStart - 1 + lineOffset;

    // Walk through the hunk and validate context lines
    let scanPos = resultStart;
    for (const hunkLine of hunkBody) {
      const indicator = hunkLine[0];
      const lineContent = hunkLine.slice(1);
      if (indicator === ' ' || indicator === '-') {
        if (scanPos >= result.length) {
          throw new Error(
            `Patch does not apply: hunk expects line ${scanPos + 1} but file has only ${result.length} lines.`,
          );
        }
        if (result[scanPos] !== lineContent) {
          throw new Error(
            `Patch does not apply: context/remove mismatch at line ${scanPos + 1}.\n` +
            `  Expected: ${JSON.stringify(lineContent)}\n` +
            `  Actual:   ${JSON.stringify(result[scanPos])}`,
          );
        }
        scanPos++;
      }
      // '+' lines don't consume original lines
    }

    // Apply the hunk: build the replacement slice
    const removedLines = hunkBody.filter((l) => l.startsWith('-') || l.startsWith(' ')).length;
    const addedLines = hunkBody
      .filter((l) => l.startsWith('+') || l.startsWith(' '))
      .map((l) => l.slice(1));

    // Validate origCount matches what we found
    const actualRemoved = hunkBody.filter((l) => l.startsWith('-') || l.startsWith(' ')).length;
    if (actualRemoved !== origCount) {
      // Tolerate mismatch silently — some diff generators omit trailing context
    }

    result.splice(resultStart, removedLines, ...addedLines);
    lineOffset += addedLines.length - removedLines;
  }

  return result.join('\n');
}

server.tool(
  'mcp_file_patch',
  'Apply a unified diff patch to a file.',
  {
    path: z.string().describe('Absolute path to the file to patch'),
    patch: z.string().describe('Unified diff patch (--- a/ +++ b/ @@ ... @@ format)'),
    dryRun: z.boolean().optional().describe('Validate patch applies cleanly without writing (default: false)'),
  },
  async ({ path, patch, dryRun }: { path: string; patch: string; dryRun?: boolean | undefined }) => {
    try {
      const doDryRun = dryRun ?? false;
      let original: string;
      try {
        original = readFileSync(path, 'utf-8');
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error reading file to patch: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }

      let patched: string;
      try {
        patched = applyUnifiedDiff(original, patch);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Patch does not apply cleanly: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }

      if (doDryRun) {
        return {
          content: [{ type: 'text' as const, text: `Dry run: patch applies cleanly. Would write ${Buffer.byteLength(patched, 'utf-8')} bytes to ${path}` }],
        };
      }

      writeFileSync(path, patched, 'utf-8');
      return {
        content: [{ type: 'text' as const, text: `Patched ${path} (${Buffer.byteLength(patched, 'utf-8')} bytes written)` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Unexpected error in mcp_file_patch: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
