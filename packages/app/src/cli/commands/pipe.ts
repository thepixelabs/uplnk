// Headless stdin pipe command — implementation pending (Flow Engine phase)

export interface PipeOptions {
  provider?: string | undefined;
  model?: string | undefined;
}

export async function runPipe(_options: PipeOptions): Promise<void> {
  process.stderr.write('uplnk pipe: headless CLI not yet implemented\n');
  process.exit(1);
}
