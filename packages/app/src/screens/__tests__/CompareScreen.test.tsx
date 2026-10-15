/**
 * CompareScreen — unit tests.
 *
 * Strategy: mock `../../hooks/useCompare.js` so we control panes/scoreboard
 * state and observe submit/vote/reveal/abortAll calls. Mock `useTerminalSize`
 * via `../../hooks/useTerminalSize.js` so we can drive the stacked-vs-row
 * layout branch deterministically.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import type { ComparePaneState } from '../../hooks/useCompare.js';
import type { CompareAggregateRow } from '../../lib/compareScoreboard.js';

const tick = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));
const ticks = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i++) await tick();
};

interface MockCompareState {
  panes: ComparePaneState[];
  blinded: boolean;
  isStreaming: boolean;
  scoreboard: CompareAggregateRow[];
  submit: ReturnType<typeof vi.fn>;
  abortAll: ReturnType<typeof vi.fn>;
  vote: ReturnType<typeof vi.fn>;
  reveal: ReturnType<typeof vi.fn>;
}

const mockState = vi.hoisted(() => ({
  // populated per-test
  state: null as MockCompareState | null,
  termCols: 200,
}));

vi.mock('../../hooks/useCompare.js', () => ({
  MAX_COMPARE_PANES: 8,
  useCompare: () => mockState.state ?? {
    panes: [],
    blinded: true,
    isStreaming: false,
    scoreboard: [],
    submit: vi.fn(),
    abortAll: vi.fn(),
    vote: vi.fn(),
    reveal: vi.fn(),
  },
}));

vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: mockState.termCols, rows: 40 }),
}));

// MarkdownMessage emits raw text — easier to assert on.
vi.mock('../../components/chat/MarkdownMessage.js', () => ({
  MarkdownMessage: ({ text }: { text: string }) => React.createElement('text', null, text),
}));

import { CompareScreen } from '../CompareScreen.js';

function pane(index: number, overrides?: Partial<ComparePaneState>): ComparePaneState {
  return {
    index,
    model: {} as ComparePaneState['model'],
    modelId: `model-${String(index)}`,
    displayLabel: String.fromCharCode(65 + index),
    messages: [],
    streamedText: '',
    status: 'idle',
    error: null,
    firstTokenMs: null,
    finishMs: null,
    ...overrides,
  };
}

function setMock(state: Partial<MockCompareState>): void {
  mockState.state = {
    panes: state.panes ?? [pane(0), pane(1)],
    blinded: state.blinded ?? true,
    isStreaming: state.isStreaming ?? false,
    scoreboard: state.scoreboard ?? [],
    submit: state.submit ?? vi.fn(),
    abortAll: state.abortAll ?? vi.fn(),
    vote: state.vote ?? vi.fn(),
    reveal: state.reveal ?? vi.fn(),
  };
}

beforeEach(() => {
  mockState.state = null;
  mockState.termCols = 200;
});

afterEach(() => {
  cleanup();
});

describe('CompareScreen', () => {
  it('renders header with mode + blind status', () => {
    setMock({});
    const out = render(
      React.createElement(CompareScreen, {
        models: [
          { languageModel: {} as never, modelId: 'a' },
          { languageModel: {} as never, modelId: 'b' },
        ],
        onExit: () => {},
        onRequestPrompt: () => null,
      }),
    );
    expect(out.lastFrame()).toContain('Compare');
    expect(out.lastFrame()).toContain('blind');
    expect(out.lastFrame()).toContain('mode: chat');
  });

  it('renders two pane labels A and B in blind mode', () => {
    setMock({});
    const out = render(
      React.createElement(CompareScreen, {
        models: [
          { languageModel: {} as never, modelId: 'a' },
          { languageModel: {} as never, modelId: 'b' },
        ],
        onExit: () => {},
        onRequestPrompt: () => null,
      }),
    );
    const frame = out.lastFrame() ?? '';
    expect(frame).toMatch(/\bA\b/);
    expect(frame).toMatch(/\bB\b/);
  });

  it('shows reveal hint while blinded and hides it when revealed', () => {
    setMock({ blinded: false });
    const out = render(
      React.createElement(CompareScreen, {
        models: [
          { languageModel: {} as never, modelId: 'a' },
          { languageModel: {} as never, modelId: 'b' },
        ],
        onExit: () => {},
        onRequestPrompt: () => null,
      }),
    );
    expect(out.lastFrame()).not.toContain('[r] reveal');
  });

  it('shows reveal hint in blind mode', () => {
    setMock({ blinded: true });
    const out = render(
      React.createElement(CompareScreen, {
        models: [
          { languageModel: {} as never, modelId: 'a' },
          { languageModel: {} as never, modelId: 'b' },
        ],
        onExit: () => {},
        onRequestPrompt: () => null,
      }),
    );
    expect(out.lastFrame()).toContain('[r] reveal');
  });

  it('"v" key votes for pane 0 when not streaming', async () => {
    const vote = vi.fn();
    setMock({ vote, isStreaming: false });
    const out = render(
      React.createElement(CompareScreen, {
        models: [
          { languageModel: {} as never, modelId: 'a' },
          { languageModel: {} as never, modelId: 'b' },
        ],
        onExit: () => {},
        onRequestPrompt: () => null,
      }),
    );
    await ticks();
    out.stdin.write('v');
    await ticks();
    expect(vote).toHaveBeenCalledWith(0);
  });

  it('"b" key votes for pane 1 when not streaming', async () => {
    const vote = vi.fn();
    setMock({ vote, isStreaming: false });
    const out = render(
      React.createElement(CompareScreen, {
        models: [
          { languageModel: {} as never, modelId: 'a' },
          { languageModel: {} as never, modelId: 'b' },
        ],
        onExit: () => {},
        onRequestPrompt: () => null,
      }),
    );
    await ticks();
    out.stdin.write('b');
    await ticks();
    expect(vote).toHaveBeenCalledWith(1);
  });

  it('"t" key votes tie', async () => {
    const vote = vi.fn();
    setMock({ vote, isStreaming: false });
    const out = render(
      React.createElement(CompareScreen, {
        models: [
          { languageModel: {} as never, modelId: 'a' },
          { languageModel: {} as never, modelId: 'b' },
        ],
        onExit: () => {},
        onRequestPrompt: () => null,
      }),
    );
    await ticks();
    out.stdin.write('t');
    await ticks();
    expect(vote).toHaveBeenCalledWith('tie');
  });

  it('vote keys are ignored while streaming', async () => {
    const vote = vi.fn();
    setMock({ vote, isStreaming: true });
    const out = render(
      React.createElement(CompareScreen, {
        models: [
          { languageModel: {} as never, modelId: 'a' },
          { languageModel: {} as never, modelId: 'b' },
        ],
        onExit: () => {},
        onRequestPrompt: () => null,
      }),
    );
    await ticks();
    out.stdin.write('v');
    await ticks();
    out.stdin.write('t');
    await ticks();
    expect(vote).not.toHaveBeenCalled();
  });

  it('"r" key calls reveal in blind mode', async () => {
    const reveal = vi.fn();
    setMock({ reveal, blinded: true });
    const out = render(
      React.createElement(CompareScreen, {
        models: [
          { languageModel: {} as never, modelId: 'a' },
          { languageModel: {} as never, modelId: 'b' },
        ],
        onExit: () => {},
        onRequestPrompt: () => null,
      }),
    );
    await ticks();
    out.stdin.write('r');
    await ticks();
    expect(reveal).toHaveBeenCalled();
  });

  it('Esc calls abortAll then onExit', async () => {
    const abortAll = vi.fn();
    const onExit = vi.fn();
    setMock({ abortAll });
    const out = render(
      React.createElement(CompareScreen, {
        models: [
          { languageModel: {} as never, modelId: 'a' },
          { languageModel: {} as never, modelId: 'b' },
        ],
        onExit,
        onRequestPrompt: () => null,
      }),
    );
    await ticks();
    out.stdin.write('\x1b'); // Esc
    await ticks();
    expect(abortAll).toHaveBeenCalled();
    expect(onExit).toHaveBeenCalled();
  });

  it('"x" calls abortAll then onExit', async () => {
    const abortAll = vi.fn();
    const onExit = vi.fn();
    setMock({ abortAll });
    const out = render(
      React.createElement(CompareScreen, {
        models: [
          { languageModel: {} as never, modelId: 'a' },
          { languageModel: {} as never, modelId: 'b' },
        ],
        onExit,
        onRequestPrompt: () => null,
      }),
    );
    await ticks();
    out.stdin.write('x');
    await ticks();
    expect(abortAll).toHaveBeenCalled();
    expect(onExit).toHaveBeenCalled();
  });

  it('"n" requests a new prompt and submits it when one is returned', async () => {
    const submit = vi.fn(async () => {});
    setMock({ submit, isStreaming: false });
    const onRequestPrompt = vi.fn(async () => 'next question');
    const out = render(
      React.createElement(CompareScreen, {
        models: [
          { languageModel: {} as never, modelId: 'a' },
          { languageModel: {} as never, modelId: 'b' },
        ],
        onExit: () => {},
        onRequestPrompt,
      }),
    );
    await ticks();
    out.stdin.write('n');
    await ticks();
    await ticks();
    expect(onRequestPrompt).toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith('next question');
  });

  it('renders scoreboard rows when scoreboard is non-empty', () => {
    setMock({
      scoreboard: [
        { model: 'alpha', wins: 3, losses: 1, ties: 0, winRate: 0.75 },
        { model: 'beta', wins: 1, losses: 3, ties: 0, winRate: 0.25 },
      ],
    });
    const out = render(
      React.createElement(CompareScreen, {
        models: [
          { languageModel: {} as never, modelId: 'a' },
          { languageModel: {} as never, modelId: 'b' },
        ],
        onExit: () => {},
        onRequestPrompt: () => null,
      }),
    );
    const frame = out.lastFrame() ?? '';
    expect(frame).toContain('alpha');
    expect(frame).toContain('3W-1L');
    expect(frame).toContain('beta');
  });

  it('shows error inside the offending pane', () => {
    setMock({
      panes: [
        pane(0, { status: 'error', error: { code: 'X', message: 'kaboom', hint: '' } as unknown as ComparePaneState['error'] }),
        pane(1),
      ],
    });
    const out = render(
      React.createElement(CompareScreen, {
        models: [
          { languageModel: {} as never, modelId: 'a' },
          { languageModel: {} as never, modelId: 'b' },
        ],
        onExit: () => {},
        onRequestPrompt: () => null,
      }),
    );
    expect(out.lastFrame()).toContain('kaboom');
  });

  it('refuses to render more than MAX_COMPARE_PANES models', () => {
    setMock({});
    const out = render(
      React.createElement(CompareScreen, {
        models: Array.from({ length: 9 }, (_, i) => ({ languageModel: {} as never, modelId: `m${String(i)}` })),
        onExit: () => {},
        onRequestPrompt: () => null,
      }),
    );
    expect(out.lastFrame()).toContain('at most 8 panes');
  });
});
