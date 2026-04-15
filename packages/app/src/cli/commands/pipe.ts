/**
 * headless pipe command — single-turn, prompt read from stdin.
 *
 * Identical to ask.ts in provider/model resolution and output rendering.
 * The only difference is that the prompt arrives from stdin rather than
 * a CLI argument, which makes it composable with shell pipelines:
 *
 *   echo "summarise this" | uplnk pipe
 *   cat notes.txt | uplnk pipe --format json
 */

import { readStdin } from '../io/stdinReader.js';
import { runAsk } from './ask.js';
import type { OutputFormat } from '../io/stdoutRenderer.js';

export interface PipeOptions {
  provider?: string | undefined;
  model?: string | undefined;
  format?: OutputFormat | undefined;
  quiet?: boolean | undefined;
}

export async function runPipe(options: PipeOptions): Promise<void> {
  const prompt = await readStdin();

  if (prompt.length === 0) {
    process.stderr.write('uplnk pipe: empty input — nothing to send.\n');
    process.exit(1);
  }

  await runAsk({ ...options, prompt });
}
