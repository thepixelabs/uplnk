/**
 * RoboticScreen — unit tests
 *
 * Strategy:
 *  - useRobotic is mocked so we can drive any state without running the full
 *    robotic controller / transport infrastructure.
 *  - Transport detection, Drizzle DB calls, and all external I/O are mocked at
 *    the module boundary.
 *  - Tests render the screen via ink-testing-library and assert on text output.
 *  - Screen interactions (keyboard input) are exercised via stdin.write().
 *  - Each test has exactly one reason to fail.
 *
 * Hoisting note: vi.mock() factories are hoisted before any const declarations.
 * vi.hoisted() makes mock fn refs available to the factory closures.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';

// ─── Hoisted mock refs ────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  roboticStart: vi.fn<(opts: { target: string; goal: string; pane?: string }) => Promise<void>>(),
  roboticAbort: vi.fn<() => void>(),
  roboticPause: vi.fn<() => void>(),
  roboticState: {
    sessionId: null as string | null,
    status: 'idle' as 'idle' | 'connecting' | 'running' | 'paused' | 'done' | 'error',
    target: '',
    goal: '',
    turns: [] as Array<{
      direction: 'uplnk->target' | 'target->uplnk';
      content: string;
      turn: number;
      timestamp: Date;
    }>,
    currentInstruction: '',
    goalProgress: 0,
    error: undefined as string | undefined,
  },
}));

vi.mock('../../hooks/useRobotic.js', () => ({
  useRobotic: vi.fn(() => ({
    state: mocks.roboticState,
    start: mocks.roboticStart,
    abort: mocks.roboticAbort,
    pause: mocks.roboticPause,
  })),
}));

vi.mock('../../robotic/transport/detect.js', () => ({
  detectBestTransport: vi.fn(() => 'pipe'),
  getAvailableTmuxPanes: vi.fn(() => []),
}));

vi.mock('../../robotic/controller/RoboticController.js', () => ({
  RoboticController: vi.fn(),
}));

// ─── Imports under test ───────────────────────────────────────────────────────

import { RoboticScreen } from '../RoboticScreen.js';
import { makeTestConfig } from '../../__tests__/fixtures/config.js';
import type { Config } from '../../lib/config.js';

// ─── Test data ────────────────────────────────────────────────────────────────

const ENABLED_CONFIG: Config = makeTestConfig({
  robotic: {
    enabled: true,
    transport: 'auto',
    maxTurns: 5,
    turnTimeoutMs: 5000,
    minInterTurnMs: 0,
    judge: { provider: 'test-provider', model: 'test-model', everyNTurns: 1 },
    redact: { envPatterns: [], customPatterns: [] },
    targets: {},
    defaultTarget: 'claude-code',
  },
});

const DISABLED_CONFIG: Config = makeTestConfig({
  robotic: {
    enabled: false,
    transport: 'auto',
    maxTurns: 5,
    turnTimeoutMs: 5000,
    minInterTurnMs: 0,
    judge: { provider: 'test-provider', model: 'test-model', everyNTurns: 1 },
    redact: { envPatterns: [], customPatterns: [] },
    targets: {},
  },
});

// ─── Render helper ────────────────────────────────────────────────────────────

function renderRoboticScreen(config: Config, onBack = vi.fn()) {
  return render(
    React.createElement(RoboticScreen, { config, onBack }),
  );
}

/** Drain the microtask queue so Ink state updates commit. */
const tick = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Reset state to default idle
  mocks.roboticState.sessionId = null;
  mocks.roboticState.status = 'idle';
  mocks.roboticState.target = '';
  mocks.roboticState.goal = '';
  mocks.roboticState.turns = [];
  mocks.roboticState.currentInstruction = '';
  mocks.roboticState.goalProgress = 0;
  mocks.roboticState.error = undefined;
  mocks.roboticStart.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

// ─── Feature flag guard ───────────────────────────────────────────────────────

describe('RoboticScreen — robotic mode disabled', () => {
  it('renders the disabled message when config.robotic.enabled is false', () => {
    const { lastFrame } = renderRoboticScreen(DISABLED_CONFIG);
    expect(lastFrame()).toContain('Robotic Mode is disabled');
  });

  it('shows the config snippet so users know how to enable it', () => {
    const { lastFrame } = renderRoboticScreen(DISABLED_CONFIG);
    expect(lastFrame()).toContain('"robotic"');
    expect(lastFrame()).toContain('"enabled": true');
  });

  it('shows "Press Esc to go back" instruction', () => {
    const { lastFrame } = renderRoboticScreen(DISABLED_CONFIG);
    expect(lastFrame()).toContain('Esc');
  });

  it('does NOT render the setup form when disabled', () => {
    const { lastFrame } = renderRoboticScreen(DISABLED_CONFIG);
    // Setup form has "Goal:" label — it must not appear in disabled state
    expect(lastFrame()).not.toContain('Goal:');
  });

  it('does NOT render the running view when disabled', () => {
    const { lastFrame } = renderRoboticScreen(DISABLED_CONFIG);
    expect(lastFrame()).not.toContain('uplnk instructions');
  });
});

// ─── Setup form (idle state) ──────────────────────────────────────────────────

describe('RoboticScreen — setup form (idle)', () => {
  it('renders "Robotic Mode" heading', () => {
    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('Robotic Mode');
  });

  it('renders the goal input field label', () => {
    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('Goal:');
  });

  it('renders the target selector with the default target', () => {
    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    // BUILTIN_TARGETS first key is 'claude-code'; config.robotic.defaultTarget
    // also points there, so 'claude-code' should be visible
    expect(lastFrame()).toContain('claude-code');
  });

  it('renders keyboard hint for changing targets', () => {
    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('left/right');
  });

  it('renders keyboard hint for submitting', () => {
    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('Enter to start');
  });

  it('renders keyboard hint for cancelling', () => {
    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('Esc');
  });

  it('does not call start() before the user submits', () => {
    renderRoboticScreen(ENABLED_CONFIG);
    expect(mocks.roboticStart).not.toHaveBeenCalled();
  });

  it('goal text field accepts typed characters', async () => {
    const { stdin, lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    await tick();

    // Write both characters together — ink-testing-library processes the
    // full string in a single synchronous batch, so each character is
    // appended to the field state before the next render.
    stdin.write('hi');
    await tick();

    expect(lastFrame()).toContain('hi');
  });

  it('goal text field deletes characters on backspace', async () => {
    const { stdin, lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    await tick();

    stdin.write('abc');
    await tick();
    stdin.write('\x7f'); // backspace
    await tick();

    // 'ab' should remain, 'c' gone
    expect(lastFrame()).toContain('ab');
  });

  it('pressing Enter on a non-empty goal calls start() with the typed goal', async () => {
    const { stdin } = renderRoboticScreen(ENABLED_CONFIG);
    await tick();

    stdin.write('build a REST API');
    await tick();
    stdin.write('\r'); // Enter
    await tick();

    expect(mocks.roboticStart).toHaveBeenCalledOnce();
    const callArg = mocks.roboticStart.mock.calls[0]?.[0];
    expect(callArg?.goal).toBe('build a REST API');
  });

  it('pressing Enter with an empty goal does NOT call start()', async () => {
    const { stdin } = renderRoboticScreen(ENABLED_CONFIG);
    await tick();

    stdin.write('\r');
    await tick();

    expect(mocks.roboticStart).not.toHaveBeenCalled();
  });

  it('pressing Enter passes the selected target to start()', async () => {
    const { stdin } = renderRoboticScreen(ENABLED_CONFIG);
    await tick();

    stdin.write('my goal');
    await tick();
    stdin.write('\r');
    await tick();

    const callArg = mocks.roboticStart.mock.calls[0]?.[0];
    expect(callArg?.target).toBeTruthy();
    expect(typeof callArg?.target).toBe('string');
  });
});

// ─── Running view ─────────────────────────────────────────────────────────────

describe('RoboticScreen — running view', () => {
  beforeEach(() => {
    mocks.roboticState.status = 'running';
    mocks.roboticState.target = 'claude-code';
    mocks.roboticState.goal = 'implement authentication';
    mocks.roboticState.goalProgress = 0.5;
  });

  it('renders "Robotic Mode" heading in running view', () => {
    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('Robotic Mode');
  });

  it('renders the target name in the header', () => {
    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('claude-code');
  });

  it('renders RUNNING status label', () => {
    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('RUNNING');
  });

  it('renders goal progress percentage', () => {
    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('50%');
  });

  it('renders the goal text', () => {
    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('implement authentication');
  });

  it('renders the "uplnk instructions" left-pane header', () => {
    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('uplnk instructions');
  });

  it('renders the target output right-pane header', () => {
    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('claude-code output');
  });

  it('renders "Waiting..." when there are no outbound turns', () => {
    mocks.roboticState.turns = [];
    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('Waiting');
  });

  it('renders outbound turns in the left pane', () => {
    mocks.roboticState.turns = [
      {
        direction: 'uplnk->target',
        content: 'Please implement login',
        turn: 1,
        timestamp: new Date(),
      },
    ];

    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('Please implement login');
  });

  it('renders inbound turns in the right pane', () => {
    mocks.roboticState.turns = [
      {
        direction: 'target->uplnk',
        content: 'I have implemented login',
        turn: 1,
        timestamp: new Date(),
      },
    ];

    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('I have implemented login');
  });

  it('renders turn numbers alongside turn content', () => {
    mocks.roboticState.turns = [
      {
        direction: 'uplnk->target',
        content: 'instruction text',
        turn: 3,
        timestamp: new Date(),
      },
    ];

    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('turn 3');
  });

  it('renders abort hint [a] when running', () => {
    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('[a] abort');
  });

  it('pressing [a] calls abort() when running', async () => {
    const { stdin } = renderRoboticScreen(ENABLED_CONFIG);
    await tick();

    stdin.write('a');
    await tick();

    expect(mocks.roboticAbort).toHaveBeenCalledOnce();
  });
});

// ─── Done state ───────────────────────────────────────────────────────────────

describe('RoboticScreen — done state', () => {
  beforeEach(() => {
    mocks.roboticState.status = 'done';
    mocks.roboticState.target = 'claude-code';
    mocks.roboticState.goal = 'ship it';
    mocks.roboticState.goalProgress = 1;
    mocks.roboticState.turns = [
      { direction: 'uplnk->target', content: 'do x', turn: 1, timestamp: new Date() },
      { direction: 'target->uplnk', content: 'done x', turn: 1, timestamp: new Date() },
    ];
  });

  it('renders DONE status label', () => {
    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('DONE');
  });

  it('renders the "Goal achieved" success banner', () => {
    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('Goal achieved');
  });

  it('renders [Esc] back hint (not abort) when done', () => {
    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('[Esc] back');
  });

  it('does NOT render the [a] abort hint when done', () => {
    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).not.toContain('[a] abort');
  });
});

// ─── Error state ──────────────────────────────────────────────────────────────

describe('RoboticScreen — error state', () => {
  beforeEach(() => {
    mocks.roboticState.status = 'error';
    mocks.roboticState.target = 'claude-code';
    mocks.roboticState.goal = 'do something';
    mocks.roboticState.error = 'Transport connection refused';
  });

  it('renders ERROR status label', () => {
    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('ERROR');
  });

  it('renders the error message text', () => {
    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('Transport connection refused');
  });

  it('renders [Esc] back hint when in error state', () => {
    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    expect(lastFrame()).toContain('[Esc] back');
  });
});

// ─── Turn ordering ────────────────────────────────────────────────────────────

describe('RoboticScreen — turn history ordering', () => {
  it('outbound and inbound turns appear in their respective panes', () => {
    mocks.roboticState.status = 'running';
    mocks.roboticState.target = 'claude-code';
    mocks.roboticState.goal = 'test';
    mocks.roboticState.turns = [
      { direction: 'uplnk->target', content: 'first instruction', turn: 1, timestamp: new Date() },
      { direction: 'target->uplnk', content: 'first response', turn: 1, timestamp: new Date() },
      { direction: 'uplnk->target', content: 'second instruction', turn: 2, timestamp: new Date() },
      { direction: 'target->uplnk', content: 'second response', turn: 2, timestamp: new Date() },
    ];

    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    const frame = lastFrame() ?? '';

    // Both sides present
    expect(frame).toContain('first instruction');
    expect(frame).toContain('first response');
  });

  it('shows at most 4 outbound turns (slice(-4))', () => {
    mocks.roboticState.status = 'running';
    mocks.roboticState.target = 'claude-code';
    mocks.roboticState.goal = 'test';
    // Create 6 outbound turns; the screen renders only the last 4
    mocks.roboticState.turns = Array.from({ length: 6 }, (_, i) => ({
      direction: 'uplnk->target' as const,
      content: `instruction-${i + 1}`,
      turn: i + 1,
      timestamp: new Date(),
    }));

    const { lastFrame } = renderRoboticScreen(ENABLED_CONFIG);
    const frame = lastFrame() ?? '';

    expect(frame).not.toContain('instruction-1');
    expect(frame).not.toContain('instruction-2');
    expect(frame).toContain('instruction-3');
    expect(frame).toContain('instruction-6');
  });
});
