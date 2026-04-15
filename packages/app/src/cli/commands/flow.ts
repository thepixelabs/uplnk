// Flow engine CLI commands — implementation pending (Flow Engine phase)

export interface FlowCommandOptions {
  action: string;
  name?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
}

export async function runFlowCommand(_options: FlowCommandOptions): Promise<void> {
  process.stderr.write('uplnk flow: flow engine not yet implemented\n');
  process.exit(1);
}
