import { spawn, type ChildProcess } from 'node:child_process';
import type { Transport, TransportEvent, TransportKind } from './Transport.js';

/**
 * PipeTransport — connects to the target CLI via stdin/stdout pipes.
 * Simplest transport: no PTY allocation, no tmux dependency. Works for
 * programs that operate fully non-interactively, but won't work with CLIs
 * that require a real TTY (most interactive AI assistants).
 *
 * Useful as a fallback or for testing with scripts/echo programs.
 */
export class PipeTransport implements Transport {
  readonly kind: TransportKind = 'pipe';

  private child: ChildProcess | null = null;
  private outputBuffer = '';
  private exitCode: number | null = null;

  constructor(
    private command: string,
    private args: string[] = [],
  ) {}

  async start(): Promise<void> {
    this.child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout?.on('data', (data: Buffer) => {
      this.outputBuffer += data.toString();
    });
    this.child.stderr?.on('data', (data: Buffer) => {
      this.outputBuffer += data.toString();
    });
    this.child.on('exit', (code) => {
      this.exitCode = code ?? 0;
    });

    // Give the process a moment to start up and print its initial prompt
    await new Promise<void>((r) => setTimeout(r, 1000));
  }

  async write(text: string): Promise<void> {
    if (this.child === null) {
      throw new Error('PipeTransport.write() called before start()');
    }
    // Pipe transport uses newline (not \r) as line terminator
    this.child.stdin?.write(text + '\n');
  }

  async readUntilIdle(opts: { timeoutMs: number; idleMs: number }): Promise<string> {
    const { timeoutMs, idleMs } = opts;
    const start = Date.now();
    let lastChangeAt = Date.now();
    let lastLength = this.outputBuffer.length;

    return new Promise((resolve) => {
      const check = setInterval(() => {
        // If the child exited, stop polling — the buffer won't grow.
        if (this.exitCode !== null) {
          clearInterval(check);
          const result = this.outputBuffer;
          this.outputBuffer = '';
          resolve(result);
          return;
        }

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
    yield { type: 'ready' };
    // Yield an exit event when the child exits
    while (this.exitCode === null) {
      await new Promise<void>((r) => setTimeout(r, 100));
    }
    yield { type: 'exit', exitCode: this.exitCode };
  }

  async close(): Promise<void> {
    this.child?.stdin?.end();
    this.child?.kill();
    this.child = null;
  }

  isReady(): boolean {
    return this.child !== null && this.exitCode === null;
  }
}
