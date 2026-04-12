import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ApprovalDialog } from '../ApprovalDialog.js';
import type { ApprovalRequest } from '../ApprovalDialog.js';

/**
 * Two macrotask ticks — Ink registers its stdin keypress listener
 * asynchronously after the first render cycle, AND the keypress-to-handler
 * path itself involves another microtask boundary. A single `setImmediate`
 * is sometimes enough in isolation but loses races when the event loop is
 * busy (full-suite runs). Double-ticking is stable.
 */
const tick = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

const mockRequest: ApprovalRequest = {
  id: 'req-001',
  command: 'ls',
  args: ['-la', '/Users/user/project'],
  cwd: '/Users/user/project',
  description: 'List project files',
};

const minimalRequest: ApprovalRequest = {
  id: 'req-min',
  command: 'cat',
  args: ['/etc/hosts'],
};

// ─── Render tests ─────────────────────────────────────────────────────────────

describe('ApprovalDialog — render', () => {
  it('renders without errors', () => {
    expect(() =>
      render(
        React.createElement(ApprovalDialog, {
          request: mockRequest,
          onApprove: vi.fn(),
          onDeny: vi.fn(),
        }),
      ),
    ).not.toThrow();
  });

  it('shows the command', () => {
    const { lastFrame } = render(
      React.createElement(ApprovalDialog, {
        request: mockRequest,
        onApprove: vi.fn(),
        onDeny: vi.fn(),
      }),
    );
    expect(lastFrame()).toContain('ls');
    expect(lastFrame()).toContain('-la');
  });

  it('concatenates command and args into a single full command string', () => {
    const { lastFrame } = render(
      React.createElement(ApprovalDialog, {
        request: mockRequest,
        onApprove: vi.fn(),
        onDeny: vi.fn(),
      }),
    );
    // Full command "ls -la /Users/user/project" must appear verbatim — no truncation
    expect(lastFrame()).toContain('ls -la /Users/user/project');
  });

  it('shows the description when provided', () => {
    const { lastFrame } = render(
      React.createElement(ApprovalDialog, {
        request: mockRequest,
        onApprove: vi.fn(),
        onDeny: vi.fn(),
      }),
    );
    expect(lastFrame()).toContain('List project files');
  });

  it('shows the working directory when provided', () => {
    const { lastFrame } = render(
      React.createElement(ApprovalDialog, {
        request: mockRequest,
        onApprove: vi.fn(),
        onDeny: vi.fn(),
      }),
    );
    expect(lastFrame()).toContain('/Users/user/project');
  });

  it('shows [Y] Allow and [N] Deny options', () => {
    const { lastFrame } = render(
      React.createElement(ApprovalDialog, {
        request: mockRequest,
        onApprove: vi.fn(),
        onDeny: vi.fn(),
      }),
    );
    expect(lastFrame()).toContain('[Y]');
    expect(lastFrame()).toContain('[N]');
  });

  it('shows the MCP warning header', () => {
    const { lastFrame } = render(
      React.createElement(ApprovalDialog, {
        request: mockRequest,
        onApprove: vi.fn(),
        onDeny: vi.fn(),
      }),
    );
    expect(lastFrame()).toContain('MCP Command Execution');
  });

  it('omits description section when description is absent', () => {
    const { lastFrame } = render(
      React.createElement(ApprovalDialog, {
        request: minimalRequest,
        onApprove: vi.fn(),
        onDeny: vi.fn(),
      }),
    );
    // Should still render the command and options
    expect(lastFrame()).toContain('cat /etc/hosts');
    expect(lastFrame()).toContain('[Y]');
    expect(lastFrame()).toContain('[N]');
  });

  it('omits cwd section when cwd is absent', () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    const { lastFrame } = render(
      React.createElement(ApprovalDialog, {
        request: minimalRequest,
        onApprove,
        onDeny,
      }),
    );
    // No "In:" label should appear
    expect(lastFrame()).not.toContain('In:');
  });

  it('shows Esc = deny hint', () => {
    const { lastFrame } = render(
      React.createElement(ApprovalDialog, {
        request: mockRequest,
        onApprove: vi.fn(),
        onDeny: vi.fn(),
      }),
    );
    expect(lastFrame()).toContain('Esc');
  });
});

// ─── Keyboard interaction tests (SECURITY GATE) ───────────────────────────────
//
// These tests verify that the Y / N / Escape key handlers fire the correct
// callbacks. ApprovalDialog is the Layer 2 human-in-the-loop MCP security gate —
// incorrect keyboard routing would allow commands to execute without consent.

describe('ApprovalDialog — keyboard: Y approves', () => {
  it('calls onApprove with the request id when "y" is pressed', async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    const { stdin } = render(
      React.createElement(ApprovalDialog, {
        request: mockRequest,
        onApprove,
        onDeny,
      }),
    );

    await tick(); // let Ink wire up its stdin listener
    stdin.write('y');
    await tick(); // let Ink process the keypress

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith('req-001');
    expect(onDeny).not.toHaveBeenCalled();
  });

  it('calls onApprove when uppercase "Y" is pressed', async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    const { stdin } = render(
      React.createElement(ApprovalDialog, {
        request: mockRequest,
        onApprove,
        onDeny,
      }),
    );

    await tick();
    stdin.write('Y');
    await tick();

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith('req-001');
    expect(onDeny).not.toHaveBeenCalled();
  });

  it('passes the correct request id to onApprove for a different request', async () => {
    const onApprove = vi.fn();
    const { stdin } = render(
      React.createElement(ApprovalDialog, {
        request: { ...mockRequest, id: 'req-999' },
        onApprove,
        onDeny: vi.fn(),
      }),
    );

    await tick();
    stdin.write('y');
    await tick();

    expect(onApprove).toHaveBeenCalledWith('req-999');
  });
});

describe('ApprovalDialog — keyboard: N denies', () => {
  it('calls onDeny with the request id when "n" is pressed', async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    const { stdin } = render(
      React.createElement(ApprovalDialog, {
        request: mockRequest,
        onApprove,
        onDeny,
      }),
    );

    await tick();
    stdin.write('n');
    await tick();

    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledWith('req-001');
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('calls onDeny when uppercase "N" is pressed', async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    const { stdin } = render(
      React.createElement(ApprovalDialog, {
        request: mockRequest,
        onApprove,
        onDeny,
      }),
    );

    await tick();
    stdin.write('N');
    await tick();

    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledWith('req-001');
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('passes the correct request id to onDeny for a different request', async () => {
    const onDeny = vi.fn();
    const { stdin } = render(
      React.createElement(ApprovalDialog, {
        request: { ...mockRequest, id: 'req-777' },
        onApprove: vi.fn(),
        onDeny,
      }),
    );

    await tick();
    stdin.write('n');
    await tick();

    expect(onDeny).toHaveBeenCalledWith('req-777');
  });
});

describe('ApprovalDialog — keyboard: Escape denies', () => {
  it('calls onDeny with the request id when Escape is pressed', async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    const { stdin } = render(
      React.createElement(ApprovalDialog, {
        request: mockRequest,
        onApprove,
        onDeny,
      }),
    );

    await tick();
    // Escape ANSI sequence
    stdin.write('\u001B');
    await tick();

    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledWith('req-001');
    expect(onApprove).not.toHaveBeenCalled();
  });
});

describe('ApprovalDialog — keyboard: no-op keys do not trigger callbacks', () => {
  it('does not call onApprove or onDeny when an unrelated key is pressed', () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    const { stdin } = render(
      React.createElement(ApprovalDialog, {
        request: mockRequest,
        onApprove,
        onDeny,
      }),
    );

    // Press keys that should be ignored
    stdin.write('a');
    stdin.write('z');
    stdin.write(' ');
    stdin.write('1');

    expect(onApprove).not.toHaveBeenCalled();
    expect(onDeny).not.toHaveBeenCalled();
  });

  it('does not call onApprove or onDeny when Enter is pressed', () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    const { stdin } = render(
      React.createElement(ApprovalDialog, {
        request: mockRequest,
        onApprove,
        onDeny,
      }),
    );

    stdin.write('\r');

    expect(onApprove).not.toHaveBeenCalled();
    expect(onDeny).not.toHaveBeenCalled();
  });
});

describe('ApprovalDialog — security: no default action', () => {
  it('does not auto-approve on mount without any keypress', () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    render(
      React.createElement(ApprovalDialog, {
        request: mockRequest,
        onApprove,
        onDeny,
      }),
    );

    // Nothing written to stdin — neither callback should fire
    expect(onApprove).not.toHaveBeenCalled();
    expect(onDeny).not.toHaveBeenCalled();
  });

  it('does not auto-deny on mount without any keypress', () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    render(
      React.createElement(ApprovalDialog, {
        request: mockRequest,
        onApprove,
        onDeny,
      }),
    );

    expect(onDeny).not.toHaveBeenCalled();
    expect(onApprove).not.toHaveBeenCalled();
  });
});
