/**
 * logoAnimation — pre-Ink startup splash for uplnk.
 *
 * Runs entirely via raw process.stdout writes before Ink mounts, so there
 * is no React state machine, no render loop, and no event-system conflict.
 * The handoff to Ink is a natural `await`.
 *
 * Sequence (total ~1.4s, skippable with any keypress):
 *   1. Hide cursor, clear screen.
 *   2. Reveal figlet UPLNK logo bottom-to-top (70ms/line).
 *   3. Hold tagline 700ms.
 *   4. Erase logo bottom-to-top (70ms/line).
 *   5. Brief 150ms pause after erase completes.
 *   6. Restore cursor — Ink takes over.
 *
 * Skipped entirely when:
 *   - stdout is not a TTY
 *   - UPLNK_NO_INTRO=1 is set
 */

import figlet from 'figlet';
import chalk from 'chalk';

// Gradient stops: cyan → violet (matches brand palette)
const GRAD_STOPS = ['#00D9FF', '#7B6FFF', '#9B59FF', '#C084FC'] as const;

/** Interpolate a hex color along the gradient for position t ∈ [0,1]. */
function gradientHex(t: number): string {
  // Map t to segment
  const segments = GRAD_STOPS.length - 1;
  const scaled = t * segments;
  const i = Math.min(Math.floor(scaled), segments - 1);
  const localT = scaled - i;

  const from = hexToRgb(GRAD_STOPS[i]!);
  const to = hexToRgb(GRAD_STOPS[Math.min(i + 1, GRAD_STOPS.length - 1)]!);

  const r = Math.round(from.r + (to.r - from.r) * localT);
  const g = Math.round(from.g + (to.g - from.g) * localT);
  const b = Math.round(from.b + (to.b - from.b) * localT);

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** Apply left-to-right gradient to a string using chalk truecolor or 256-color fallback. */
function applyGradient(text: string): string {
  if (chalk.level === 0) return text;

  const chars = [...text];
  const nonSpace = chars.filter((c) => c !== ' ').length;
  if (nonSpace === 0) return text;

  let colorIdx = 0;
  return chars
    .map((ch) => {
      if (ch === ' ') return ch;
      const t = nonSpace > 1 ? colorIdx / (nonSpace - 1) : 0;
      colorIdx++;
      const hex = gradientHex(t);
      if (chalk.level >= 3) {
        return chalk.hex(hex)(ch);
      } else if (chalk.level >= 2) {
        // 256-color approximation — cyan (#39) at start, violet (#99) at end
        const code = t < 0.5 ? 51 : t < 0.75 ? 105 : 99;
        return `\x1b[38;5;${code}m${ch}\x1b[39m`;
      } else {
        // 16-color: bold cyan
        return `\x1b[1;36m${ch}\x1b[0m`;
      }
    })
    .join('');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the startup logo animation.
 * Returns immediately if not in a TTY, UPLNK_NO_INTRO=1, or options.enabled === false.
 *
 * The splash can also be suppressed via config.json:
 *   { "splashScreen": { "enabled": false } }
 * which the caller translates to options.enabled = false before calling here.
 */
export async function runLogoAnimation(options?: { enabled?: boolean }): Promise<void> {
  if (!process.stdout.isTTY) return;
  if (process.env['UPLNK_NO_INTRO'] === '1') return;
  if (options?.enabled === false) return;

  const LINE_DELAY = 70; // ms per line reveal/erase
  const HOLD_MS = 700;   // ms to hold after full reveal

  // Generate the ASCII logo with figlet using Slant font.
  // Falls back to the simple wordmark if figlet fails for any reason.
  let logoLines: string[];
  try {
    const raw = figlet.textSync('UPLNK', { font: 'Slant', horizontalLayout: 'default' });
    logoLines = raw.split('\n').filter((l, i, arr) => {
      // Trim trailing empty lines but keep leading structure
      if (i < arr.length - 1) return true;
      return l.trim().length > 0;
    });
  } catch {
    logoLines = ['  UPLNK'];
  }

  const taglineText = 'terminal-native AI  ·  local-first';
  const tagline = chalk.hex('#6B7280')(taglineText);

  // Skip-key listener — any keypress sets skip flag
  let skipped = false;
  const onKey = () => { skipped = true; };
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', onKey);
  }

  // Hide cursor
  process.stdout.write('\x1b[?25l');
  // Clear screen and home
  process.stdout.write('\x1b[2J\x1b[H');

  // Center the logo block vertically
  const termRows = process.stdout.rows ?? 24;
  const termCols = process.stdout.columns ?? 80;
  const blockHeight = logoLines.length + 2; // logo + blank + tagline
  const topPad = Math.max(0, Math.floor((termRows - blockHeight) / 2));

  // Move to top padding
  process.stdout.write(`\x1b[${topPad + 1};1H`);

  // Phase 1: Reveal bottom-to-top
  // We first print all lines invisible, then repaint them colored one by one
  // from bottom to top to create the "reveal from bottom" effect.
  // Strategy: print all lines dim-blank first, then overwrite from bottom-up.

  // Print placeholder lines (spaces)
  const maxLineLen = Math.max(...logoLines.map((l) => l.length));
  const padLeft = Math.max(0, Math.floor((termCols - maxLineLen) / 2));
  const indent = ' '.repeat(padLeft);

  for (let i = 0; i < logoLines.length; i++) {
    process.stdout.write(`${indent}${' '.repeat(maxLineLen)}\n`);
  }
  // Compute centered tagline indent (independent of logo indent).
  const taglineVisibleLen = taglineText.length;
  const taglineIndent = ' '.repeat(Math.max(0, Math.floor((termCols - taglineVisibleLen) / 2)));

  // tagline placeholder
  process.stdout.write(`\n${taglineIndent}${' '.repeat(taglineVisibleLen)}`);

  // Now reveal logo lines from bottom to top
  for (let i = logoLines.length - 1; i >= 0; i--) {
    if (skipped) break;
    const row = topPad + 1 + i;
    const coloredLine = applyGradient(logoLines[i]!);
    // Move cursor to that row, column 1
    process.stdout.write(`\x1b[${row};1H${indent}${coloredLine}\x1b[0m`);
    await sleep(LINE_DELAY);
  }

  // Show tagline
  if (!skipped) {
    const tagRow = topPad + logoLines.length + 2;
    process.stdout.write(`\x1b[${tagRow};1H${taglineIndent}${tagline}`);
    await sleep(HOLD_MS);
  }

  // Phase 2: Erase bottom-to-top
  if (!skipped) {
    const tagRow = topPad + logoLines.length + 2;
    // Erase tagline first
    process.stdout.write(
      `\x1b[${tagRow};1H${taglineIndent}${' '.repeat(taglineVisibleLen)}`,
    );
    await sleep(LINE_DELAY);

    for (let i = logoLines.length - 1; i >= 0; i--) {
      if (skipped) break;
      const row = topPad + 1 + i;
      process.stdout.write(`\x1b[${row};1H${indent}${' '.repeat(maxLineLen)}\x1b[0m`);
      await sleep(LINE_DELAY);
    }

    // Brief pause after erase so the screen isn't immediately overwritten
    await sleep(150);
  }

  // Clean up skip listener
  if (process.stdin.isTTY) {
    process.stdin.off('data', onKey);
    // Don't close stdin — Ink needs it. But we should restore non-raw mode
    // only if we set it. Ink will re-set raw mode when it mounts.
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    process.stdin.pause();
  }

  // Clear screen cleanly before Ink takes over
  process.stdout.write('\x1b[2J\x1b[H');
  // Restore cursor — Ink will manage it from here
  process.stdout.write('\x1b[?25h');
}
