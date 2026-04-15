/**
 * Headless robotic-mode runner — stub.
 *
 * Robotic mode currently ships only through the TUI (see RoboticScreen).
 * A headless entry point requires surfacing the planner/judge progress
 * as structured events on stdout; that work is tracked separately.
 *
 * This command intentionally exits non-zero so CI pipelines don't mistake
 * a stub run for success, but we print to stderr (not stdout) so any
 * scripting that pipes our output isn't corrupted.
 */

export interface RoboticCommandOptions {
  target: string;
  goal: string;
  provider?: string | undefined;
  model?: string | undefined;
}

export async function runRoboticCommand(_options: RoboticCommandOptions): Promise<void> {
  process.stderr.write(
    'uplnk robotic: headless robotic mode is not yet available.\n' +
      'Run `uplnk` and open Robotic Mode from the menu for now.\n',
  );
  process.exit(2);
}
