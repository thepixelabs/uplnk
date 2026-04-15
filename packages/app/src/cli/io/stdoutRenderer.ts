/**
 * stdoutRenderer — format and emit streaming AI output to stdout.
 *
 * Three output formats:
 *
 *   plain   Stream text deltas directly to stdout as they arrive.
 *           Final newline is written only if the response text does not
 *           already end with one (mirrors `echo`-style conventions).
 *           Usage stats are suppressed unless quiet === false, in which
 *           case they go to stderr so they never corrupt script output.
 *
 *   json    Collect all deltas silently, then print a single JSON object:
 *             { "text": "...", "usage": { "inputTokens": N, "outputTokens": N } }
 *           Progress dots are written to stderr when quiet === false.
 *
 *   ndjson  Print each delta as a newline-delimited JSON event:
 *             {"v":1,"type":"delta","text":"..."}
 *           Followed by a final done event:
 *             {"v":1,"type":"done","usage":{"inputTokens":N,"outputTokens":N}}
 *           Errors are emitted as:
 *             {"v":1,"type":"error","message":"..."}
 */

export type OutputFormat = 'plain' | 'json' | 'ndjson';

export interface RendererOptions {
  format: OutputFormat;
  /** When true, suppress informational progress output to stderr. */
  quiet: boolean;
}

export class StdoutRenderer {
  private readonly format: OutputFormat;
  private readonly quiet: boolean;
  /** Accumulated text for 'json' format. */
  private collected = '';
  /** Whether the last written character to stdout was a newline (plain format). */
  private lastWasNewline = false;

  constructor(opts: RendererOptions) {
    this.format = opts.format;
    this.quiet = opts.quiet;
  }

  /** Called for each streaming text delta. */
  onDelta(text: string): void {
    if (text.length === 0) return;

    switch (this.format) {
      case 'plain':
        process.stdout.write(text);
        this.lastWasNewline = text.endsWith('\n');
        break;

      case 'json':
        this.collected += text;
        if (!this.quiet) {
          // Show a progress indicator to stderr so the user knows work is
          // happening while the full response is being collected.
          process.stderr.write('.');
        }
        break;

      case 'ndjson':
        this.writeLine({ v: 1, type: 'delta', text });
        break;
    }
  }

  /** Called when the stream completes. */
  onDone(usage: { inputTokens: number; outputTokens: number }): void {
    switch (this.format) {
      case 'plain':
        // Ensure the caller's shell prompt starts on a fresh line.
        if (!this.lastWasNewline) {
          process.stdout.write('\n');
        }
        if (!this.quiet) {
          process.stderr.write(
            `\n[tokens: ${String(usage.inputTokens)} in / ${String(usage.outputTokens)} out]\n`,
          );
        }
        break;

      case 'json': {
        if (!this.quiet) {
          // Terminate the progress dots line.
          process.stderr.write('\n');
        }
        const output = JSON.stringify({ text: this.collected, usage });
        process.stdout.write(output + '\n');
        break;
      }

      case 'ndjson':
        this.writeLine({ v: 1, type: 'done', usage });
        break;
    }
  }

  /** Called when the stream encounters an error. */
  onError(err: Error): void {
    switch (this.format) {
      case 'plain':
        process.stderr.write(`\nError: ${err.message}\n`);
        break;

      case 'json':
        if (!this.quiet) {
          process.stderr.write('\n');
        }
        // On error we still emit valid JSON so scripts can parse it.
        process.stdout.write(
          JSON.stringify({ error: err.message }) + '\n',
        );
        break;

      case 'ndjson':
        this.writeLine({ v: 1, type: 'error', message: err.message });
        break;
    }
  }

  /** Write a single JSON-serialised line followed by a newline character. */
  writeLine(obj: unknown): void {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }
}
