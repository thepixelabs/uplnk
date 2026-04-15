import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Transport, TransportEvent, TransportKind } from './Transport.js';

const execFileAsync = promisify(execFile);

// Pane format: "session:window.pane" (e.g. "main:0.1") or bare pane id "%N"
const PANE_ID_RE = /^[a-zA-Z0-9_.-]+:[0-9]+\.[0-9]+$|^%[0-9]+$/;

export interface TmuxTransportOptions {
  /** tmux pane target, e.g. "session:window.pane" or "%1" */
  pane: string;
  /** tmux socket path (from $TMUX env var) */
  socket?: string;
}

/**
 * Strip ANSI escape sequences from terminal output.
 * Handles CSI sequences, OSC sequences, and single-char ESC sequences.
 */
function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b[<=]/g, '');
}

/**
 * TmuxTransport — reads/writes a tmux pane using tmux send-keys and
 * capture-pane. Preferred when $TMUX is set in the environment.
 *
 * Security: pane IDs are validated against PANE_ID_RE and always passed
 * as separate execFile arguments — never interpolated into shell strings.
 */
export class TmuxTransport implements Transport {
  readonly kind: TransportKind = 'tmux';

  private ready = false;

  constructor(private opts: TmuxTransportOptions) {}

  async start(): Promise<void> {
    if (!PANE_ID_RE.test(this.opts.pane)) {
      throw new Error(
        `Invalid tmux pane id: "${this.opts.pane}". ` +
          'Must match session:window.pane (e.g. "main:0.1") or %N (e.g. "%1").',
      );
    }

    // Verify the pane exists by running tmux display-message on it.
    // execFile with an array — no shell interpolation.
    const tmuxArgs = [
      ...(this.opts.socket !== undefined ? ['-S', this.opts.socket] : []),
      'display-message',
      '-t',
      this.opts.pane,
      '-p',
      '#{pane_id}',
    ];

    try {
      await execFileAsync('tmux', tmuxArgs);
    } catch {
      throw new Error(
        `tmux pane "${this.opts.pane}" not found. ` +
          'Run `tmux list-panes -a` to see available panes.',
      );
    }

    this.ready = true;
  }

  async write(text: string): Promise<void> {
    if (!this.ready) {
      throw new Error('TmuxTransport.write() called before start()');
    }

    // send-keys with -l sends literal text (no key binding interpretation).
    // We send the text first, then Enter as a separate key — this lets
    // tmux treat the newline as a key press rather than literal text,
    // which is how interactive CLIs expect input.
    const sendArgs = [
      ...(this.opts.socket !== undefined ? ['-S', this.opts.socket] : []),
      'send-keys',
      '-t',
      this.opts.pane,
      '-l',
      text,
    ];
    await execFileAsync('tmux', sendArgs);

    // Send Enter separately as a named key (not literal) so the target
    // CLI receives CRLF correctly regardless of terminal settings.
    const enterArgs = [
      ...(this.opts.socket !== undefined ? ['-S', this.opts.socket] : []),
      'send-keys',
      '-t',
      this.opts.pane,
      'Enter',
    ];
    await execFileAsync('tmux', enterArgs);
  }

  async readUntilIdle(opts: { timeoutMs: number; idleMs: number }): Promise<string> {
    const { timeoutMs, idleMs } = opts;
    const POLL_INTERVAL_MS = 200;

    const captureArgs = [
      ...(this.opts.socket !== undefined ? ['-S', this.opts.socket] : []),
      'capture-pane',
      '-p',
      '-S',
      '-200',
      '-t',
      this.opts.pane,
    ];

    const deadline = Date.now() + timeoutMs;
    let lastOutput = '';
    let lastChangeAt = Date.now();

    // Initial capture to establish baseline
    try {
      const { stdout } = await execFileAsync('tmux', captureArgs);
      lastOutput = stripAnsi(stdout);
      lastChangeAt = Date.now();
    } catch {
      return '';
    }

    return new Promise((resolve) => {
      const poll = setInterval(async () => {
        try {
          const { stdout } = await execFileAsync('tmux', captureArgs);
          const current = stripAnsi(stdout);

          if (current !== lastOutput) {
            lastOutput = current;
            lastChangeAt = Date.now();
          }

          const now = Date.now();
          const idleFor = now - lastChangeAt;
          const timedOut = now >= deadline;

          if (idleFor >= idleMs || timedOut) {
            clearInterval(poll);
            resolve(lastOutput);
          }
        } catch {
          clearInterval(poll);
          resolve(lastOutput);
        }
      }, POLL_INTERVAL_MS);
    });
  }

  async *events(): AsyncIterable<TransportEvent> {
    yield { type: 'ready' };
  }

  async close(): Promise<void> {
    // Nothing to clean up — tmux pane lifecycle is managed externally.
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }
}
