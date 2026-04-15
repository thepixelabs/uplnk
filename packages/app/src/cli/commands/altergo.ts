// Altergo integration CLI commands — implementation pending (Altergo phase)

export interface AltergoCommandOptions {
  action: string;
  args: string[];
}

export async function runAltergoCommand(_options: AltergoCommandOptions): Promise<void> {
  process.stderr.write('uplnk altergo: altergo integration not yet implemented\n');
  process.exit(1);
}
