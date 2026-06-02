/**
 * Tests for McpStatusPanel — collapsed-by-default rendering, expand on
 * Enter, ANSI escape stripping, and the basic keyboard surface (r, c, Esc).
 *
 * The panel pulls getConfigPath from lib/config; mock it so the test
 * doesn't hit the real ~/.uplnk path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';

vi.mock('../../../lib/config.js', () => ({
  getConfigPath: vi.fn(() => '/tmp/uplnk-test/.uplnk/config.json'),
}));

vi.mock('clipboardy', () => ({
  default: { writeSync: vi.fn() },
}));

import { McpStatusPanel } from '../McpStatusPanel.js';
import type { FailedConnection } from '../../../lib/mcp/McpManager.js';

const tick = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

function makeFailed(overrides: Partial<FailedConnection> = {}): FailedConnection {
  return {
    config: { id: 'myco', name: 'Myco (Ableton Live)', type: 'stdio', command: 'uv', args: [] },
    error: new Error('MCP error -32000: Connection closed'),
    stderrTail: [
      'Traceback (most recent call last):',
      '  File "/abs/server.py", line 8, in <module>',
      '    from .role_registry import RoleRegistry',
      'ImportError: attempted relative import with no known parent package',
    ].join('\n'),
    ...overrides,
  };
}

describe('McpStatusPanel — empty', () => {
  it('shows the "all connected" message when no failures', () => {
    const { lastFrame } = render(
      React.createElement(McpStatusPanel, {
        failedServers: [],
        onRetry: vi.fn(async () => {}),
        onClose: vi.fn(),
      }),
    );
    expect(lastFrame()).toContain('All configured MCP servers are connected');
  });
});

describe('McpStatusPanel — failures', () => {
  it('renders one summary line per failure (collapsed by default)', () => {
    const { lastFrame } = render(
      React.createElement(McpStatusPanel, {
        failedServers: [makeFailed()],
        onRetry: vi.fn(async () => {}),
        onClose: vi.fn(),
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Myco (Ableton Live)');
    expect(frame).toContain('(myco)');
    expect(frame).toContain('MCP error -32000: Connection closed');
    // stderr stays hidden until the user expands the row.
    expect(frame).not.toContain('Traceback');
    expect(frame).not.toContain('ImportError');
    expect(frame).not.toContain('stderr (last');
  });

  it('expands the selected row to show stderr on Enter, then collapses on Enter again', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(McpStatusPanel, {
        failedServers: [makeFailed()],
        onRetry: vi.fn(async () => {}),
        onClose: vi.fn(),
      }),
    );
    await tick();
    stdin.write('\r');
    await tick();
    let frame = lastFrame() ?? '';
    expect(frame).toContain('stderr (last');
    expect(frame).toContain('Traceback');
    expect(frame).toContain('ImportError');

    stdin.write('\r');
    await tick();
    frame = lastFrame() ?? '';
    expect(frame).not.toContain('Traceback');
    expect(frame).not.toContain('stderr (last');
  });

  it('strips ANSI SGR escapes from stderr when expanded', async () => {
    const ansiTail = '\x1B[31mERROR\x1B[0m something broke\n\x1B[2;3mhint\x1B[0m line';
    const { stdin, lastFrame } = render(
      React.createElement(McpStatusPanel, {
        failedServers: [makeFailed({ stderrTail: ansiTail })],
        onRetry: vi.fn(async () => {}),
        onClose: vi.fn(),
      }),
    );
    await tick();
    stdin.write('\r');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ERROR something broke');
    expect(frame).toContain('hint line');
    // Raw escape sequence must not survive to the rendered frame.
    expect(frame).not.toContain('\x1B[');
  });

  it('arrow keys move the selection cursor between failures', async () => {
    const failures = [
      makeFailed({ config: { id: 'first', name: 'First', type: 'stdio', command: 'a', args: [] }, error: new Error('first error') }),
      makeFailed({ config: { id: 'second', name: 'Second', type: 'stdio', command: 'b', args: [] }, error: new Error('second error') }),
    ];
    const { stdin, lastFrame } = render(
      React.createElement(McpStatusPanel, {
        failedServers: failures,
        onRetry: vi.fn(async () => {}),
        onClose: vi.fn(),
      }),
    );
    await tick();
    // Cursor starts at row 0. Expanding it must reveal first's stderr.
    stdin.write('\r');
    await tick();
    let frame = lastFrame() ?? '';
    expect(frame).toContain('Traceback');

    // Collapse, move down to row 1, expand again.
    stdin.write('\r');
    await tick();
    stdin.write('\x1B[B'); // down arrow
    await tick();
    stdin.write('\r');
    await tick();
    frame = lastFrame() ?? '';
    // Second is now the expanded row.
    expect(frame).toContain('Second');
    expect(frame).toContain('Traceback');
  });

  it('Esc invokes onClose', async () => {
    const onClose = vi.fn();
    const { stdin } = render(
      React.createElement(McpStatusPanel, {
        failedServers: [makeFailed()],
        onRetry: vi.fn(async () => {}),
        onClose,
      }),
    );
    await tick();
    stdin.write('\x1B');
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('r triggers retry when there is at least one failure', async () => {
    const onRetry = vi.fn(async () => {});
    const { stdin } = render(
      React.createElement(McpStatusPanel, {
        failedServers: [makeFailed()],
        onRetry,
        onClose: vi.fn(),
      }),
    );
    await tick();
    stdin.write('r');
    await tick();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does nothing on r when there are no failures', async () => {
    const onRetry = vi.fn(async () => {});
    const { stdin } = render(
      React.createElement(McpStatusPanel, {
        failedServers: [],
        onRetry,
        onClose: vi.fn(),
      }),
    );
    await tick();
    stdin.write('r');
    await tick();
    expect(onRetry).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
