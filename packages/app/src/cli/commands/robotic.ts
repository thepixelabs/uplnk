// Robotic mode CLI command — implementation pending (Robotic Mode phase)

export interface RoboticCommandOptions {
  target: string;
  goal: string;
  provider?: string | undefined;
  model?: string | undefined;
}

export async function runRoboticCommand(_options: RoboticCommandOptions): Promise<void> {
  process.stderr.write('uplnk robotic: robotic mode not yet implemented\n');
  process.exit(1);
}
