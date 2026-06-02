/**
 * Mouse wheel events from the terminal, dispatched as a small subscription bus.
 *
 * The entrypoint enables SGR mouse reporting (CSI ?1000h + ?1006h). Terminals
 * then emit `ESC [ < b ; x ; y M|m` for each press/release/wheel notch.
 * b=64 → wheel up, b=65 → wheel down (modifier bits live in the upper bits).
 *
 * We attach a passive `data` listener to process.stdin — Ink keeps its own
 * listener; both fire on every chunk. We only emit events for wheel codes;
 * other mouse activity (clicks, drags) is ignored.
 */

type WheelDirection = 'up' | 'down';
type WheelHandler = (dir: WheelDirection) => void;

const handlers = new Set<WheelHandler>();
let installed = false;
let onData: ((chunk: Buffer | string) => void) | null = null;

const SGR_RE = /\x1b\[<(\d+);\d+;\d+[Mm]/g;

function parseAndDispatch(chunk: Buffer | string): void {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  if (!text.includes('\x1b[<')) return;
  SGR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SGR_RE.exec(text)) !== null) {
    const b = Number(match[1]);
    // Bit 6 (0x40) marks a wheel event. Bit 0 distinguishes up (0) vs down (1).
    // Upper bits encode modifiers (shift/alt/ctrl) — we ignore them.
    if ((b & 0x40) !== 0x40) continue;
    const dir: WheelDirection = (b & 1) === 0 ? 'up' : 'down';
    for (const h of handlers) {
      try { h(dir); } catch { /* swallow — one bad handler must not break others */ }
    }
  }
}

export function installMouseListener(): void {
  if (installed) return;
  if (!process.stdin.isTTY) return;
  installed = true;
  onData = parseAndDispatch;
  process.stdin.on('data', onData);
}

export function uninstallMouseListener(): void {
  if (!installed) return;
  installed = false;
  if (onData !== null) {
    process.stdin.off('data', onData);
    onData = null;
  }
}

export function onWheel(handler: WheelHandler): () => void {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}

/**
 * SGR mouse sequences arrive at Ink's `useInput` after Ink strips the leading
 * ESC, so the `input` arg looks like `[<64;10;20M`. Consumers should call this
 * to suppress those before they fall through to character-input handlers.
 */
export function isMouseInputResidue(input: string): boolean {
  return /^\[<\d+;\d+;\d+[Mm]$/.test(input);
}
