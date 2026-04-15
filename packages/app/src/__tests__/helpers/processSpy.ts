import { vi, type MockInstance } from 'vitest';

export interface ProcessSpies {
  stdout: MockInstance;
  stderr: MockInstance;
  exit: MockInstance;
  getStdout(): string;
  getStderr(): string;
  getExitCode(): number | undefined;
  restore(): void;
}

/**
 * Spies on process.stdout.write, process.stderr.write, and process.exit.
 * Prevents actual output during CLI tests.
 * Call restore() in afterEach.
 */
export function spyOnProcess(): ProcessSpies {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const exit = vi.spyOn(process, 'exit').mockImplementation(
    (_code?: string | number | null) => {
      // Don't actually exit
      return undefined as never;
    },
  );

  return {
    stdout,
    stderr,
    exit,
    getStdout(): string {
      return stdout.mock.calls
        .map((call) => String(call[0]))
        .join('');
    },
    getStderr(): string {
      return stderr.mock.calls
        .map((call) => String(call[0]))
        .join('');
    },
    getExitCode(): number | undefined {
      const calls = exit.mock.calls;
      if (calls.length === 0) return undefined;
      return calls[calls.length - 1]?.[0] as number | undefined;
    },
    restore(): void {
      stdout.mockRestore();
      stderr.mockRestore();
      exit.mockRestore();
    },
  };
}
