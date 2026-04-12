/**
 * McpManager audit log rotation tests.
 *
 * Strategy:
 * - Use a real temp dir for the pylon dir so actual file I/O is exercised.
 * - Mock only the module boundaries we don't own: MCP SDK Client/Transport
 *   (prevents child-process spawning), uplnk-db/getPylonDir (controls path).
 * - node:fs is NOT mocked here — rotation depends on real statSync / renameSync.
 * - logToolCall is private; we access it via a type cast so we can write
 *   audit entries directly without going through the full connect() lifecycle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── SDK mocks — prevent real subprocess spawning ─────────────────────────────

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    callTool: vi.fn().mockResolvedValue({ content: [] }),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({})),
}));

// ─── uplnk-db mock — makes getPylonDir return our temp dir ───────────────────

vi.mock('uplnk-db', () => ({
  db: {},
  getPylonDir: vi.fn(() => '/tmp/audit-test-default'),
}));

import { getPylonDir } from 'uplnk-db';
import { McpManager } from '../../lib/mcp/McpManager.js';
import { createDefaultPolicy } from '../../lib/mcp/security.js';
import type { AuditEntry } from '../../lib/mcp/McpManager.js';

const mockGetPylonDir = vi.mocked(getPylonDir);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEN_MB = 10 * 1024 * 1024;

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pylon-audit-'));
}

function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function makeManager(pylonDir: string): McpManager {
  mockGetPylonDir.mockReturnValue(pylonDir);
  return new McpManager({
    filePolicy: createDefaultPolicy([pylonDir]),
    commandExecEnabled: false,
    gitEnabled: false,
    ragEnabled: false,
    requestApproval: vi.fn().mockResolvedValue(true),
  });
}

/**
 * Access logToolCall via a type cast. The cast is an explicit test affordance —
 * the implementation deliberately does not export a test helper for this path.
 */
function callLogToolCall(manager: McpManager, entry: AuditEntry): void {
  (manager as unknown as { logToolCall(e: AuditEntry): void }).logToolCall(entry);
}

function makeEntry(tool = 'mcp_file_read'): AuditEntry {
  return {
    ts: new Date().toISOString(),
    tool,
    args: { path: '/tmp/file.txt' },
    outcome: 'allowed',
    detail: 'test entry',
  };
}

/** Write a file of exactly `bytes` size by repeating a character. */
function writeFileOfSize(filePath: string, bytes: number): void {
  // Write in 1MB chunks to avoid a giant string allocation.
  const chunk = Buffer.alloc(Math.min(bytes, 1024 * 1024), 0x41); // 'A'
  let remaining = bytes;
  const fs = require('node:fs') as typeof import('node:fs');
  fs.writeFileSync(filePath, ''); // truncate / create
  while (remaining > 0) {
    const n = Math.min(remaining, chunk.length);
    fs.appendFileSync(filePath, chunk.subarray(0, n));
    remaining -= n;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('McpManager audit log rotation', () => {
  let tmpDir: string;
  let auditLog: string;
  let backupLog: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    auditLog = join(tmpDir, 'mcp-audit.log');
    backupLog = `${auditLog}.1`;
    mockGetPylonDir.mockReturnValue(tmpDir);
    vi.clearAllMocks();
    mockGetPylonDir.mockReturnValue(tmpDir);
  });

  afterEach(() => {
    removeTempDir(tmpDir);
  });

  it('does not rotate when the log is below the 10MB threshold', () => {
    const manager = makeManager(tmpDir);
    // Write a file well below the threshold.
    writeFileSync(auditLog, 'small content\n', 'utf-8');

    callLogToolCall(manager, makeEntry());

    // Backup must not exist.
    expect(existsSync(backupLog)).toBe(false);
    // Log must still exist.
    expect(existsSync(auditLog)).toBe(true);
  });

  it('rotates when the log is at exactly the 10MB threshold', () => {
    const manager = makeManager(tmpDir);
    writeFileOfSize(auditLog, TEN_MB);

    callLogToolCall(manager, makeEntry());

    // After rotation: backup exists, main log exists with only the new entry.
    expect(existsSync(backupLog)).toBe(true);
    expect(existsSync(auditLog)).toBe(true);

    const newLogSize = statSync(auditLog).size;
    expect(newLogSize).toBeLessThan(TEN_MB);
  });

  it('after rotation the new log contains only the latest entry', () => {
    const manager = makeManager(tmpDir);
    writeFileOfSize(auditLog, TEN_MB);

    callLogToolCall(manager, makeEntry('mcp_file_read'));

    const contents = readFileSync(auditLog, 'utf-8');
    // Should be a single JSONL line.
    const lines = contents.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(parsed['tool']).toBe('mcp_file_read');
  });

  it('the backup (.1) contains the pre-rotation bytes', () => {
    const manager = makeManager(tmpDir);
    const originalContent = 'A'.repeat(TEN_MB);
    writeFileSync(auditLog, originalContent, 'utf-8');

    callLogToolCall(manager, makeEntry());

    const backupSize = statSync(backupLog).size;
    expect(backupSize).toBe(TEN_MB);
  });

  it('second rotation clobbers .1 — no .2 is ever created', () => {
    const manager = makeManager(tmpDir);

    // First rotation.
    writeFileOfSize(auditLog, TEN_MB);
    callLogToolCall(manager, makeEntry());
    expect(existsSync(backupLog)).toBe(true);

    // Grow the log back to threshold for the second rotation.
    writeFileOfSize(auditLog, TEN_MB);
    callLogToolCall(manager, makeEntry());

    // No .2 file.
    expect(existsSync(`${backupLog}.2`)).toBe(false);
    // .1 was clobbered but still exists.
    expect(existsSync(backupLog)).toBe(true);
  });

  it('skips rotation cleanly when the log file does not exist yet', () => {
    const manager = makeManager(tmpDir);
    // auditLog does not exist — make sure it wasn't created in beforeEach.
    expect(existsSync(auditLog)).toBe(false);

    // Must not throw.
    expect(() => callLogToolCall(manager, makeEntry())).not.toThrow();

    // Log is created by the append.
    expect(existsSync(auditLog)).toBe(true);
    expect(existsSync(backupLog)).toBe(false);
  });
});
