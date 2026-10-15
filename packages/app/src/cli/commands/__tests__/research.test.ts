/**
 * research.test.ts
 *
 * Unit tests for runResearchCommand(). Config, DB, secrets, the language
 * model factory, the search-provider bridge, and the deep-research runner are
 * all mocked at their module boundaries so only the command's wiring is
 * exercised: provider/model resolution, fail-fast on missing search config,
 * stderr progress rendering, and the stdout report contract.
 *
 * process.exit() is made to THROW (ProcessExitError) on error-path tests so
 * control flow stops at the exit call, mirroring production (same convention
 * as ask.test.ts / flow.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spyOnProcess } from '../../../__tests__/helpers/processSpy.js';
import { makeFakeProviderRow } from '../../../__tests__/helpers/fakeProviderRow.js';
import type { ResearchEvent } from '../../../lib/deepResearch/runnerTypes.js';

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

vi.mock('../../../lib/config.js', () => ({
  getOrCreateConfig: vi.fn(),
}));

vi.mock('../../../lib/languageModelFactory.js', () => ({
  createLanguageModel: vi.fn(() => ({ provider: 'mock', modelId: 'mock-model' })),
}));

vi.mock('../../../lib/secrets.js', () => ({
  resolveSecret: vi.fn((v: unknown) => (typeof v === 'string' ? v : null)),
}));

vi.mock('../../../lib/search/fromConfig.js', () => ({
  buildSearchProviderFromConfig: vi.fn(),
}));

vi.mock('../../../lib/deepResearch/runner.js', () => ({
  runResearch: vi.fn(),
}));

// ── Static imports (after mocks) ──────────────────────────────────────────────

import { getOrCreateConfig } from '../../../lib/config.js';
import { createLanguageModel } from '../../../lib/languageModelFactory.js';
import { buildSearchProviderFromConfig } from '../../../lib/search/fromConfig.js';
import { runResearch } from '../../../lib/deepResearch/runner.js';
import { getDefaultProvider, getProviderById } from '@uplnk/db';
import { runResearchCommand } from '../research.js';

const mockGetOrCreateConfig = vi.mocked(getOrCreateConfig);
const mockCreateLanguageModel = vi.mocked(createLanguageModel);
const mockBuildSearch = vi.mocked(buildSearchProviderFromConfig);
const mockRunResearch = vi.mocked(runResearch);
const mockGetDefaultProvider = vi.mocked(getDefaultProvider);
const mockGetProviderById = vi.mocked(getProviderById);

// ── Sentinel error class ──────────────────────────────────────────────────────

class ProcessExitError extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
    this.name = 'ProcessExitError';
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROVIDER_ROW = makeFakeProviderRow({
  id: 'ollama-local',
  providerType: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  apiKey: 'ollama',
  defaultModel: 'qwen2.5:7b',
});

const BASE_CONFIG = {
  ok: true as const,
  config: {
    headless: { defaultProvider: undefined, defaultModel: undefined, persist: false },
    search: { fallbackChain: [] },
  },
};

const HAPPY_EVENTS: ResearchEvent[] = [
  { type: 'plan:start' },
  { type: 'plan:done', category: 'general', planSummary: '2 sub-question(s): a / b\nSuccess: done' },
  { type: 'round:start', round: 1, queries: ['q one', 'q two'] },
  { type: 'search:result', round: 1, query: 'q one', resultCount: 4 },
  { type: 'extract:done', round: 1, sourceUrl: 'https://example.com/a', confidence: 0.8 },
  { type: 'synthesize:start', round: 1 },
  { type: 'synthesize:done', round: 1, reportLength: 900 },
  { type: 'round:end', round: 1, durationMs: 4200, newFindingsCount: 1 },
  { type: 'final:start' },
  { type: 'final:delta', delta: '# Rep' },
  { type: 'final:done', report: '# Report\n\nfindings [https://example.com/a]', sources: ['https://example.com/a'], durationMs: 9000 },
];

function makeGen(events: ResearchEvent[]): AsyncGenerator<ResearchEvent, unknown, void> {
  return (async function* () {
    for (const ev of events) yield ev;
    return undefined;
  })();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetOrCreateConfig.mockReturnValue(BASE_CONFIG as unknown as ReturnType<typeof getOrCreateConfig>);
  mockGetDefaultProvider.mockReturnValue(PROVIDER_ROW);
  mockGetProviderById.mockReturnValue(PROVIDER_ROW);
  mockBuildSearch.mockReturnValue({
    ok: true,
    provider: { name: 'duckduckgo', health: async () => true, search: async () => [] },
    chain: ['duckduckgo'],
  });
  mockRunResearch.mockImplementation(() => makeGen(HAPPY_EVENTS) as ReturnType<typeof runResearch>);
});

function installThrowingExit(spy: ReturnType<typeof spyOnProcess>): void {
  spy.exit.mockImplementation((code?: string | number | null): never => {
    throw new ProcessExitError(typeof code === 'number' ? code : undefined);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runResearchCommand — happy path', () => {
  it('writes the final report (and ONLY the report) to stdout', async () => {
    const spy = spyOnProcess();
    await runResearchCommand({ topic: 'handpan history' });
    const out = spy.getStdout();
    spy.restore();

    expect(out).toBe('# Report\n\nfindings [https://example.com/a]\n');
  });

  it('streams phase progress lines to stderr', async () => {
    const spy = spyOnProcess();
    await runResearchCommand({ topic: 'handpan history' });
    const errOut = spy.getStderr();
    spy.restore();

    expect(errOut).toContain('Researching: handpan history');
    expect(errOut).toContain('planning research');
    expect(errOut).toContain('round 1');
    expect(errOut).toContain('q one');
    expect(errOut).toContain('extracted https://example.com/a');
    expect(errOut).toContain('writing final report');
    expect(errOut).toContain('1 source(s)');
    expect(spy.exit).not.toHaveBeenCalled();
  });

  it('resolves model precedence: --model flag beats provider default', async () => {
    const spy = spyOnProcess();
    await runResearchCommand({ topic: 't', model: 'llama3.1:8b' });
    spy.restore();

    expect(mockCreateLanguageModel).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'llama3.1:8b' }),
    );
  });

  it('passes the resolved search provider and an abort signal to runResearch', async () => {
    const spy = spyOnProcess();
    await runResearchCommand({ topic: 'abc' });
    spy.restore();

    expect(mockRunResearch).toHaveBeenCalledTimes(1);
    const opts = mockRunResearch.mock.calls[0]![0];
    expect(opts.query).toBe('abc');
    expect(opts.search).toEqual(expect.objectContaining({ name: 'duckduckgo' }));
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('runResearchCommand — error paths', () => {
  it('fails fast when no search provider is configured, naming the config keys', async () => {
    mockBuildSearch.mockReturnValue({
      ok: false,
      error:
        'no search provider configured. Set `search.tavily.apiKey` or `search.brave.apiKey` in ~/.uplnk/config.json (or export TAVILY_API_KEY / BRAVE_API_KEY), or opt into keyless DuckDuckGo with `search.default: "duckduckgo"`.',
    });

    const spy = spyOnProcess();
    installThrowingExit(spy);
    await expect(runResearchCommand({ topic: 't' })).rejects.toThrow(ProcessExitError);
    const errOut = spy.getStderr();
    const exitCode = spy.getExitCode();
    spy.restore();

    expect(exitCode).toBe(1);
    expect(errOut).toContain('search.tavily.apiKey');
    expect(errOut).toContain('search.brave.apiKey');
    expect(mockRunResearch).not.toHaveBeenCalled();
  });

  it('exits 1 when no provider is configured', async () => {
    mockGetDefaultProvider.mockReturnValue(undefined);

    const spy = spyOnProcess();
    installThrowingExit(spy);
    await expect(runResearchCommand({ topic: 't' })).rejects.toThrow(ProcessExitError);
    const errOut = spy.getStderr();
    const exitCode = spy.getExitCode();
    spy.restore();

    expect(exitCode).toBe(1);
    expect(errOut).toContain('no provider configured');
  });

  it('exits 1 with "failed" when the runner throws', async () => {
    mockRunResearch.mockImplementation(() =>
      (async function* (): AsyncGenerator<ResearchEvent, unknown, void> {
        yield { type: 'plan:start' };
        throw new Error('model unreachable');
      })() as ReturnType<typeof runResearch>,
    );

    const spy = spyOnProcess();
    installThrowingExit(spy);
    await expect(runResearchCommand({ topic: 't' })).rejects.toThrow(ProcessExitError);
    const errOut = spy.getStderr();
    const exitCode = spy.getExitCode();
    spy.restore();

    expect(exitCode).toBe(1);
    expect(errOut).toContain('failed — model unreachable');
  });

  it('exits 1 when the run finishes without a final report', async () => {
    mockRunResearch.mockImplementation(() =>
      makeGen([{ type: 'plan:start' }]) as ReturnType<typeof runResearch>,
    );

    const spy = spyOnProcess();
    installThrowingExit(spy);
    await expect(runResearchCommand({ topic: 't' })).rejects.toThrow(ProcessExitError);
    const errOut = spy.getStderr();
    const exitCode = spy.getExitCode();
    const out = spy.getStdout();
    spy.restore();

    expect(exitCode).toBe(1);
    expect(errOut).toContain('no report produced');
    expect(out).toBe('');
  });

  it('exits 1 when config loading fails', async () => {
    mockGetOrCreateConfig.mockReturnValue({ ok: false, error: 'corrupt json' });

    const spy = spyOnProcess();
    installThrowingExit(spy);
    await expect(runResearchCommand({ topic: 't' })).rejects.toThrow(ProcessExitError);
    const errOut = spy.getStderr();
    const exitCode = spy.getExitCode();
    spy.restore();

    expect(exitCode).toBe(1);
    expect(errOut).toContain('config error');
  });
});
