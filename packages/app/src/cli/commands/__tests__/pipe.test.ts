/**
 * pipe.test.ts
 *
 * Unit tests for runPipe().
 *
 * pipe.ts is a thin adapter: it reads from stdin then delegates to runAsk().
 * We mock readStdin and runAsk entirely so we only test the glue layer —
 * that it passes the stdin content as the prompt, forwards all options, and
 * handles the empty-stdin error path.
 *
 * IMPORTANT: process.exit() does not halt execution unless the mock throws.
 * For the empty-stdin path we install a throwing mock so code after the
 * `process.exit(1)` call in pipe.ts does not run and attempt to call runAsk.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spyOnProcess } from '../../../__tests__/helpers/processSpy.js';

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

vi.mock('../../io/stdinReader.js', () => ({
  readStdin: vi.fn(),
}));

vi.mock('../ask.js', () => ({
  runAsk: vi.fn(async () => undefined),
}));

// ── Static imports (after mocks) ──────────────────────────────────────────────

import { readStdin } from '../../io/stdinReader.js';
import { runAsk } from '../ask.js';
import { runPipe } from '../pipe.js';

const mockReadStdin = vi.mocked(readStdin);
const mockRunAsk = vi.mocked(runAsk);

// ── Sentinel error class ──────────────────────────────────────────────────────

class ProcessExitError extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
    this.name = 'ProcessExitError';
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runPipe — happy path', () => {
  it('passes stdin content as the prompt to runAsk', async () => {
    mockReadStdin.mockResolvedValueOnce('summarise this document');

    await runPipe({});

    expect(mockRunAsk).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'summarise this document' }),
    );
  });

  it('forwards format option to runAsk', async () => {
    mockReadStdin.mockResolvedValueOnce('query');

    await runPipe({ format: 'json' });

    expect(mockRunAsk).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'json' }),
    );
  });

  it('forwards provider option to runAsk', async () => {
    mockReadStdin.mockResolvedValueOnce('query');

    await runPipe({ provider: 'anthropic-prod' });

    expect(mockRunAsk).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'anthropic-prod' }),
    );
  });

  it('forwards model option to runAsk', async () => {
    mockReadStdin.mockResolvedValueOnce('query');

    await runPipe({ model: 'claude-3-5-sonnet' });

    expect(mockRunAsk).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-3-5-sonnet' }),
    );
  });

  it('forwards quiet option to runAsk', async () => {
    mockReadStdin.mockResolvedValueOnce('query');

    await runPipe({ quiet: true });

    expect(mockRunAsk).toHaveBeenCalledWith(
      expect.objectContaining({ quiet: true }),
    );
  });

  it('forwards ndjson format to runAsk unchanged', async () => {
    mockReadStdin.mockResolvedValueOnce('data');

    await runPipe({ format: 'ndjson' });

    expect(mockRunAsk).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'ndjson', prompt: 'data' }),
    );
  });
});

describe('runPipe — empty stdin', () => {
  it('exits nonzero with a descriptive message when stdin is empty', async () => {
    mockReadStdin.mockResolvedValueOnce('');

    const spy = spyOnProcess();
    // Make process.exit throw so runPipe stops and never reaches runAsk
    spy.exit.mockImplementationOnce((code) => {
      throw new ProcessExitError(code as number);
    });

    let caught: ProcessExitError | undefined;
    try {
      await runPipe({});
    } catch (e) {
      if (e instanceof ProcessExitError) caught = e;
      else throw e;
    }
    const stderr = spy.getStderr();
    spy.restore();

    expect(caught?.code).toBe(1);
    expect(stderr).toContain('empty input');
  });

  it('does NOT call runAsk when stdin is empty', async () => {
    mockReadStdin.mockResolvedValueOnce('');

    const spy = spyOnProcess();
    spy.exit.mockImplementationOnce((code) => {
      throw new ProcessExitError(code as number);
    });

    try {
      await runPipe({});
    } catch (e) {
      if (!(e instanceof ProcessExitError)) throw e;
    }
    spy.restore();

    expect(mockRunAsk).not.toHaveBeenCalled();
  });
});
