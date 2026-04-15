import type { Transport, TransportEvent, TransportKind } from './Transport.js';

/**
 * Strip ANSI escape sequences from PTY output.
 */
function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b[<=]/g, '');
}

/**
 * PtyTransport — spawns the target CLI as a PTY child process.
 * node-pty is imported dynamically so the rest of uplnk functions even
 * when node-pty is not installed (falls back to tmux or pipe transport).
 */
export class PtyTransport implements Transport {
  readonly kind: TransportKind = 'pty';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pty: any = null;
  private outputBuffer = '';
  private eventQueue: TransportEvent[] = [];
  private closed = false;

  constructor(
    private command: string,
    private args: string[] = [],
    private env?: Record<string, string>,
  ) {}

  async start(): Promise<void> {
    // Dynamic import so the module is not required at load time.
    // We use a string-concat trick to prevent TypeScript from resolving the
    // module at compile time (it's an optional peer dep that may not exist).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ptyModule: any;
    const ptyModuleName = 'node-pty'; // prevent static analysis
    try {
      ptyModule = await import(/* @vite-ignore */ ptyModuleName);
    } catch {
      throw new Error(
        'node-pty is not installed. Install it with: pnpm add node-pty\n' +
          'Or use tmux transport instead: set robotic.transport = "tmux" in config.',
      );
    }

    this.pty = ptyModule.spawn(this.command, this.args, {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      env: this.env ?? { ...process.env },
    });

    this.pty.onData((data: string) => {
      this.outputBuffer += stripAnsi(data);
      this.eventQueue.push({ type: 'data', data });
    });

    this.pty.onExit(({ exitCode }: { exitCode: number }) => {
      this.closed = true;
      this.eventQueue.push({ type: 'exit', exitCode });
    });

    // Heuristic: wait 2 s for the target CLI to print its first prompt
    // before declaring "ready". Real readiness detection (readyRegex) is
    // the controller's job, but this buys time for slow-starting CLIs.
    await new Promise<void>((r) => setTimeout(r, 2000));
    this.eventQueue.push({ type: 'ready' });
  }

  async write(text: string): Promise<void> {
    if (this.pty === null) {
      throw new Error('PtyTransport.write() called before start()');
    }
    // \r is the correct line terminator for PTY (Enter key)
    this.pty.write(text + '\r');
  }

  async readUntilIdle(opts: { timeoutMs: number; idleMs: number }): Promise<string> {
    const { timeoutMs, idleMs } = opts;
    const start = Date.now();
    let lastChangeAt = Date.now();
    let lastLength = this.outputBuffer.length;

    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (this.outputBuffer.length !== lastLength) {
          lastLength = this.outputBuffer.length;
          lastChangeAt = Date.now();
        }

        const now = Date.now();
        if (now - lastChangeAt >= idleMs || now - start >= timeoutMs) {
          clearInterval(check);
          const result = this.outputBuffer;
          this.outputBuffer = '';
          resolve(result);
        }
      }, 100);
    });
  }

  async *events(): AsyncIterable<TransportEvent> {
    while (!this.closed || this.eventQueue.length > 0) {
      if (this.eventQueue.length > 0) {
        yield this.eventQueue.shift()!;
      } else {
        await new Promise<void>((r) => setTimeout(r, 50));
      }
    }
  }

  async close(): Promise<void> {
    this.pty?.kill();
    this.pty = null;
  }

  isReady(): boolean {
    return this.pty !== null && !this.closed;
  }
}
