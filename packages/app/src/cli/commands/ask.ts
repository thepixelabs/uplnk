// Headless one-shot ask command — implementation pending (Flow Engine phase)

export interface AskOptions {
  prompt: string;
  provider?: string | undefined;
  model?: string | undefined;
}

export async function runAsk(_options: AskOptions): Promise<void> {
  process.stderr.write('uplnk ask: headless CLI not yet implemented\n');
  process.exit(1);
}
