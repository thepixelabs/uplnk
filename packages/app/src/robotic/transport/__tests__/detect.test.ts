/**
 * Tests for packages/app/src/robotic/transport/detect.ts
 *
 * Behaviors under test:
 *  - detectBestTransport: explicit transport bypasses detection entirely
 *  - detectBestTransport: 'auto' + $TMUX set → 'tmux'
 *  - detectBestTransport: 'auto' + no $TMUX → 'pty' (default fallback)
 *  - getAvailableTmuxPanes: returns [] when not inside tmux
 *  - getAvailableTmuxPanes: returns [] when tmux binary errors
 *  - getAvailableTmuxPanes: parses pane output correctly when inside tmux
 *  - getAvailableTmuxPaneIds: extracts only %N ids from pane descriptions
 *
 * Mocking strategy:
 *  - process.env is saved/restored around each test to prevent TMUX leakage
 *  - execFileSync is mocked at the module boundary so no real tmux subprocess
 *    is spawned — allows tests to run outside tmux sessions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted mock refs ────────────────────────────────────────────────────────
// vi.mock factories are hoisted before imports; the ref must live in
// vi.hoisted() to be accessible both inside the factory and in test bodies.

const childProcessMocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: childProcessMocks.execFileSync,
}));

// ─── Import under test ────────────────────────────────────────────────────────

import {
  detectBestTransport,
  getAvailableTmuxPanes,
  getAvailableTmuxPaneIds,
} from '../detect.js';

// ─── Environment helpers ──────────────────────────────────────────────────────

let savedTmux: string | undefined;

beforeEach(() => {
  savedTmux = process.env['TMUX'];
  delete process.env['TMUX'];
  childProcessMocks.execFileSync.mockReset();
});

afterEach(() => {
  if (savedTmux === undefined) {
    delete process.env['TMUX'];
  } else {
    process.env['TMUX'] = savedTmux;
  }
});

// ─── detectBestTransport ──────────────────────────────────────────────────────

describe('detectBestTransport', () => {
  describe('when given an explicit (non-auto) preference', () => {
    it('returns tmux directly without inspecting env', () => {
      // $TMUX is NOT set — but the explicit preference wins
      expect(detectBestTransport('tmux')).toBe('tmux');
    });

    it('returns pty directly without inspecting env', () => {
      process.env['TMUX'] = '/tmp/tmux-1234/default,5,0';
      // $TMUX IS set, but explicit pty wins over auto-detection
      expect(detectBestTransport('pty')).toBe('pty');
    });

    it('returns pipe directly without inspecting env', () => {
      process.env['TMUX'] = '/tmp/tmux-1234/default,5,0';
      expect(detectBestTransport('pipe')).toBe('pipe');
    });
  });

  describe("when preference is 'auto'", () => {
    it("returns 'tmux' when $TMUX env var is set", () => {
      process.env['TMUX'] = '/tmp/tmux-1234/default,5,0';
      expect(detectBestTransport('auto')).toBe('tmux');
    });

    it("returns 'pty' when $TMUX is not set", () => {
      // $TMUX was deleted in beforeEach
      expect(detectBestTransport('auto')).toBe('pty');
    });

    it("returns 'pty' when $TMUX is set to an empty string", () => {
      // An empty string is falsy — treated the same as absent
      process.env['TMUX'] = '';
      expect(detectBestTransport('auto')).toBe('pty');
    });
  });
});

// ─── getAvailableTmuxPanes ────────────────────────────────────────────────────

describe('getAvailableTmuxPanes', () => {
  it('returns an empty array when $TMUX is not set', () => {
    // $TMUX deleted in beforeEach — no subprocess should be spawned
    expect(getAvailableTmuxPanes()).toEqual([]);
    expect(childProcessMocks.execFileSync).not.toHaveBeenCalled();
  });

  it('returns an empty array when execFileSync throws', () => {
    process.env['TMUX'] = '/tmp/tmux-1234/default,5,0';
    childProcessMocks.execFileSync.mockImplementation(() => {
      throw new Error('tmux: no server running');
    });
    expect(getAvailableTmuxPanes()).toEqual([]);
  });

  it('returns parsed pane descriptions when inside tmux', () => {
    process.env['TMUX'] = '/tmp/tmux-1234/default,5,0';
    const raw = '%0  main  zsh\n%1  editor  nvim\n%2  server  node\n';
    childProcessMocks.execFileSync.mockReturnValue(raw);

    const panes = getAvailableTmuxPanes();

    expect(panes).toEqual(['%0  main  zsh', '%1  editor  nvim', '%2  server  node']);
  });

  it('strips trailing blank lines from the tmux output', () => {
    process.env['TMUX'] = '/tmp/tmux-1234/default,5,0';
    childProcessMocks.execFileSync.mockReturnValue('%0  win  bash\n\n\n');

    expect(getAvailableTmuxPanes()).toEqual(['%0  win  bash']);
  });

  it('passes the correct format string to tmux list-panes', () => {
    process.env['TMUX'] = '/tmp/tmux-1234/default,5,0';
    childProcessMocks.execFileSync.mockReturnValue('');

    getAvailableTmuxPanes();

    expect(childProcessMocks.execFileSync).toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining([
        'list-panes',
        '-a',
        '-F',
        '#{pane_id}  #{window_name}  #{pane_current_command}',
      ]),
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });
});

// ─── getAvailableTmuxPaneIds ──────────────────────────────────────────────────

describe('getAvailableTmuxPaneIds', () => {
  it('returns an empty array when not inside tmux', () => {
    expect(getAvailableTmuxPaneIds()).toEqual([]);
  });

  it('extracts only %N identifiers from pane descriptions', () => {
    process.env['TMUX'] = '/tmp/tmux-1234/default,5,0';
    childProcessMocks.execFileSync.mockReturnValue(
      '%0  main  zsh\n%1  editor  nvim\n%12  logs  tail\n',
    );

    expect(getAvailableTmuxPaneIds()).toEqual(['%0', '%1', '%12']);
  });

  it('excludes lines whose first token does not start with %', () => {
    process.env['TMUX'] = '/tmp/tmux-1234/default,5,0';
    // Malformed tmux output — only valid pane ids should be returned
    childProcessMocks.execFileSync.mockReturnValue(
      '%0  win  bash\nbad-line  something\n%1  win2  zsh\n',
    );

    expect(getAvailableTmuxPaneIds()).toEqual(['%0', '%1']);
  });
});
