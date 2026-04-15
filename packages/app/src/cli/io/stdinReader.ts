/**
 * stdinReader — read all of stdin until EOF.
 *
 * Two modes:
 *   - Piped input (non-TTY):  read chunks until the stream closes, return the
 *     accumulated string trimmed of leading/trailing whitespace.
 *   - Interactive TTY:        print a prompt to stderr, read a single line,
 *     and return it. This is the fallback so `uplnk pipe` is usable without
 *     piping — the user can type a prompt and press Enter.
 */

import { createInterface } from 'node:readline';

/**
 * Read all of stdin until EOF and return the trimmed result.
 *
 * When stdin is a TTY (i.e. no pipe), we prompt the user on stderr and read
 * one line.  The prompt goes to stderr so it never pollutes stdout (important
 * when the caller is collecting the response for further processing).
 */
export async function readStdin(): Promise<string> {
  // TTY path — stdin is a terminal, not a pipe.
  if (process.stdin.isTTY) {
    process.stderr.write('Enter prompt (press Enter when done): ');
    return new Promise<string>((resolve, reject) => {
      const rl = createInterface({ input: process.stdin, output: undefined });
      let line = '';
      rl.once('line', (input) => {
        line = input;
        rl.close();
      });
      rl.once('close', () => resolve(line.trim()));
      rl.once('error', reject);
    });
  }

  // Piped path — read all chunks until EOF.
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.once('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8').trim());
    });
    process.stdin.once('error', reject);
  });
}
