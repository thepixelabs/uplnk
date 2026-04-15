import { execFileSync } from 'node:child_process';
import type { TransportKind } from './Transport.js';

/**
 * Pick the best available transport for the current environment.
 *
 * Priority:
 *  1. User's explicit preference (anything other than 'auto')
 *  2. tmux — if $TMUX is set in the environment
 *  3. pty — default when outside tmux (node-pty may not be installed;
 *     the actual import failure is handled gracefully in PtyTransport)
 */
export function detectBestTransport(
  preferredTransport: 'auto' | TransportKind,
): TransportKind {
  if (preferredTransport !== 'auto') return preferredTransport;
  if (process.env['TMUX']) return 'tmux';
  return 'pty';
}

/**
 * Return the list of available tmux panes with enough context to let
 * the user pick one. Each string is a human-readable description of one
 * pane, suitable for display in the setup UI.
 *
 * Format: "%N  window_name  current_command"
 *
 * Returns [] when not inside tmux or when tmux is unreachable.
 */
export function getAvailableTmuxPanes(): string[] {
  if (!process.env['TMUX']) return [];

  try {
    const raw = execFileSync('tmux', [
      'list-panes',
      '-a',
      '-F',
      '#{pane_id}  #{window_name}  #{pane_current_command}',
    ], { encoding: 'utf-8', timeout: 2000 });

    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/**
 * Extract just the pane IDs ("%N") from the list returned by
 * getAvailableTmuxPanes(). Useful when you need to default to a pane id
 * for TmuxTransport without showing the full description.
 */
export function getAvailableTmuxPaneIds(): string[] {
  return getAvailableTmuxPanes()
    .map((line) => line.split(/\s+/)[0] ?? '')
    .filter((id) => id.startsWith('%'));
}
