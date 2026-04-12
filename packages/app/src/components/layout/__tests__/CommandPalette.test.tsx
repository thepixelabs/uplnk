import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { CommandPalette } from '../CommandPalette.js';
import type { PaletteCommand } from '../CommandPalette.js';

const tick = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const makeCmd = (
  id: string,
  name: string,
  opts: Partial<PaletteCommand> = {},
): PaletteCommand => ({
  id,
  name,
  execute: vi.fn(),
  ...opts,
});

const commands: PaletteCommand[] = [
  makeCmd('new-chat', 'New Chat', { shortcut: 'Ctrl+N', description: 'Start a new conversation' }),
  makeCmd('export-md', 'Export Markdown', { description: 'Export chat as Markdown' }),
  makeCmd('export-json', 'Export JSON', { description: 'Export chat as JSON' }),
  makeCmd('model-select', 'Select Model', { shortcut: '/model' }),
  makeCmd('provider-select', 'Switch Provider', { shortcut: '/provider' }),
  makeCmd('disabled-cmd', 'Disabled Command', { disabled: true }),
];

// ─── Render tests ─────────────────────────────────────────────────────────────

describe('CommandPalette — render', () => {
  it('renders without errors', () => {
    expect(() =>
      render(React.createElement(CommandPalette, { commands, onClose: vi.fn() })),
    ).not.toThrow();
  });

  it('shows the search placeholder text', () => {
    const { lastFrame } = render(
      React.createElement(CommandPalette, { commands, onClose: vi.fn() }),
    );
    expect(lastFrame()).toContain('search commands');
  });

  it('shows command names', () => {
    const { lastFrame } = render(
      React.createElement(CommandPalette, { commands, onClose: vi.fn() }),
    );
    expect(lastFrame()).toContain('New Chat');
    expect(lastFrame()).toContain('Export Markdown');
  });

  it('shows shortcuts when provided', () => {
    const { lastFrame } = render(
      React.createElement(CommandPalette, { commands, onClose: vi.fn() }),
    );
    expect(lastFrame()).toContain('Ctrl+N');
    expect(lastFrame()).toContain('/model');
  });

  it('shows descriptions when provided', () => {
    const { lastFrame } = render(
      React.createElement(CommandPalette, { commands, onClose: vi.fn() }),
    );
    expect(lastFrame()).toContain('Start a new conversation');
  });

  it('shows navigation hint', () => {
    const { lastFrame } = render(
      React.createElement(CommandPalette, { commands, onClose: vi.fn() }),
    );
    expect(lastFrame()).toContain('↑↓');
    expect(lastFrame()).toContain('Enter');
    expect(lastFrame()).toContain('Esc');
  });

  it('does not show disabled commands', () => {
    const { lastFrame } = render(
      React.createElement(CommandPalette, { commands, onClose: vi.fn() }),
    );
    expect(lastFrame()).not.toContain('Disabled Command');
  });

  it('renders with empty command list without errors', () => {
    expect(() =>
      render(React.createElement(CommandPalette, { commands: [], onClose: vi.fn() })),
    ).not.toThrow();
  });
});

// ─── Escape closes ─────────────────────────────────────────────────────────────

describe('CommandPalette — Escape closes', () => {
  it('calls onClose when Escape is pressed', async () => {
    const onClose = vi.fn();
    const { stdin } = render(
      React.createElement(CommandPalette, { commands, onClose }),
    );
    await tick();
    stdin.write('\u001B');
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ─── Enter executes selected command ──────────────────────────────────────────

describe('CommandPalette — Enter executes', () => {
  it('calls execute on the first (default-selected) command when Enter is pressed', async () => {
    const execute = vi.fn();
    const cmds: PaletteCommand[] = [makeCmd('cmd-a', 'Alpha', { execute })];
    const onClose = vi.fn();
    const { stdin } = render(
      React.createElement(CommandPalette, { commands: cmds, onClose }),
    );
    await tick();
    stdin.write('\r');
    await tick();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes before executing so the palette does not stay open', async () => {
    const callOrder: string[] = [];
    const onClose = vi.fn(() => callOrder.push('close'));
    const execute = vi.fn(() => callOrder.push('execute'));
    const cmds: PaletteCommand[] = [makeCmd('cmd-a', 'Alpha', { execute })];
    const { stdin } = render(
      React.createElement(CommandPalette, { commands: cmds, onClose }),
    );
    await tick();
    stdin.write('\r');
    await tick();
    expect(callOrder).toEqual(['close', 'execute']);
  });

  it('does not call execute when command list is empty', () => {
    const onClose = vi.fn();
    const { stdin } = render(
      React.createElement(CommandPalette, { commands: [], onClose }),
    );
    stdin.write('\r');
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ─── Typing filters commands ──────────────────────────────────────────────────

describe('CommandPalette — fuzzy filter', () => {
  it('typing narrows the displayed commands', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(CommandPalette, { commands, onClose: vi.fn() }),
    );
    await tick();
    stdin.write('export');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Export');
    // Unrelated commands should be filtered out
    expect(frame).not.toContain('New Chat');
  });

  it('shows "No commands match" for unmatched query', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(CommandPalette, { commands, onClose: vi.fn() }),
    );
    await tick();
    stdin.write('xyzzy');
    await tick();
    expect(lastFrame()).toContain('No commands match');
  });

  it('matching is case-insensitive', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(CommandPalette, { commands, onClose: vi.fn() }),
    );
    await tick();
    stdin.write('EXPORT');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Export');
  });

  it('backspace removes last typed character', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(CommandPalette, { commands, onClose: vi.fn() }),
    );
    await tick();
    stdin.write('exportx');
    await tick();
    // 'exportx' matches nothing
    expect(lastFrame()).toContain('No commands match');
    stdin.write('\u007F'); // backspace
    await tick();
    // After removing 'x', 'export' matches
    expect(lastFrame()).toContain('Export');
  });
});

// ─── Keyboard navigation ──────────────────────────────────────────────────────

describe('CommandPalette — down arrow moves cursor', () => {
  it('selects the second command after one down-arrow press', async () => {
    const execute1 = vi.fn();
    const execute2 = vi.fn();
    const cmds: PaletteCommand[] = [
      makeCmd('first', 'First Command', { execute: execute1 }),
      makeCmd('second', 'Second Command', { execute: execute2 }),
    ];
    const onClose = vi.fn();
    const { stdin } = render(
      React.createElement(CommandPalette, { commands: cmds, onClose }),
    );
    await tick();
    // Move down to second item then press Enter
    stdin.write('\u001B[B'); // down arrow ANSI sequence
    await tick();
    stdin.write('\r');
    await tick();
    expect(execute2).toHaveBeenCalledTimes(1);
    expect(execute1).not.toHaveBeenCalled();
  });
});
