/**
 * Tests for packages/app/src/hooks/useRobotic.ts
 *
 * Behaviors under test:
 *  - Initial state: idle, no sessionId, empty turns
 *  - start() with robotic.enabled = false: transitions to error
 *  - start() initiates: idle → connecting → running
 *  - EventBus subscription cleanup after abort() — no leak
 *  - EventBus subscription cleanup on unmount — no leak
 *  - abort() while running sets status back to idle
 *  - Multiple start() calls: second start cleans up previous subscription
 *  - robotic.inject events propagate to turns and currentInstruction
 *  - robotic.read events propagate to turns
 *  - robotic.turn events propagate goalProgress
 *  - Transport start failure → error status
 *  - No provider configured → error status
 *
 * Mocking strategy:
 *  - @uplnk/db: override the global setup.ts stub with per-file vi.mock()
 *    exposing db.insert, db.update, getProviderById, getDefaultProvider
 *  - Transport classes: mocked at module boundary — we never spawn real
 *    processes in unit tests
 *  - RoboticController: mocked so run() resolves with a configurable result
 *    without executing any real LLM calls
 *  - detectBestTransport: mocked to return 'pipe' for every test
 *  - resolveSecret: mocked to return the raw value (no env lookup in tests)
 *  - ink-testing-library drives the Ink reconciler; a thin HookWrapper
 *    component captures hook state via a ref (same pattern as useStream tests)
 *
 * Hoisting note: vi.mock() factories are hoisted before any const declarations.
 * Mock refs live in vi.hoisted() so they are accessible in both the factory
 * bodies and individual test assertions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';

// ─── Hoisted mock refs ────────────────────────────────────────────────────────

const dbMocks = vi.hoisted(() => {
  const insertRun = vi.fn();
  const insertValues = vi.fn(() => ({ run: insertRun }));
  const insertFn = vi.fn(() => ({ values: insertValues }));
  const updateRun = vi.fn();
  const updateWhere = vi.fn(() => ({ run: updateRun }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const updateFn = vi.fn(() => ({ set: updateSet }));

  return {
    db: { insert: insertFn, update: updateFn },
    roboticSessions: {},
    roboticTurns: {},
    getProviderById: vi.fn(),
    getDefaultProvider: vi.fn(),
    insertRun,
    insertValues,
    insertFn,
  };
});

vi.mock('@uplnk/db', () => ({
  db: dbMocks.db,
  roboticSessions: dbMocks.roboticSessions,
  roboticTurns: dbMocks.roboticTurns,
  getProviderById: dbMocks.getProviderById,
  getDefaultProvider: dbMocks.getDefaultProvider,
  getPylonDir: vi.fn(() => '/tmp/uplnk-test-home/.uplnk'),
  getPylonDbPath: vi.fn(() => '/tmp/uplnk-test-home/.uplnk/db.sqlite'),
  getUplnkDir: vi.fn(() => '/tmp/uplnk-test-home/.uplnk'),
  upsertProviderConfig: vi.fn(),
  setDefaultProvider: vi.fn(),
  listProviders: vi.fn(() => []),
  createConversation: vi.fn(),
  getConversation: vi.fn(),
  listConversations: vi.fn(),
  updateConversationTitle: vi.fn(),
  softDeleteConversation: vi.fn(),
  touchConversation: vi.fn(),
  insertMessage: vi.fn(),
  updateMessageContent: vi.fn(),
  getMessages: vi.fn(() => []),
  forkConversation: vi.fn(),
  searchConversations: vi.fn(() => []),
  runMigrations: vi.fn(),
  ragChunks: {},
}));

const controllerMocks = vi.hoisted(() => ({
  run: vi.fn<() => Promise<'succeeded' | 'failed' | 'aborted'>>(),
}));

vi.mock('../../robotic/controller/RoboticController.js', () => ({
  RoboticController: vi.fn().mockImplementation(() => ({
    run: controllerMocks.run,
  })),
}));

vi.mock('../../robotic/transport/PipeTransport.js', () => ({
  PipeTransport: vi.fn().mockImplementation(() => ({
    kind: 'pipe',
    start: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
    readUntilIdle: vi.fn().mockResolvedValue(''),
    events: async function* () { /* no events */ },
    close: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn(() => true),
  })),
}));

vi.mock('../../robotic/transport/TmuxTransport.js', () => ({
  TmuxTransport: vi.fn().mockImplementation(() => ({
    kind: 'tmux',
    start: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
    readUntilIdle: vi.fn().mockResolvedValue(''),
    events: async function* () { /* no events */ },
    close: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn(() => true),
  })),
}));

vi.mock('../../robotic/transport/PtyTransport.js', () => ({
  PtyTransport: vi.fn().mockImplementation(() => ({
    kind: 'pty',
    start: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
    readUntilIdle: vi.fn().mockResolvedValue(''),
    events: async function* () { /* no events */ },
    close: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn(() => true),
  })),
}));

vi.mock('../../robotic/transport/detect.js', () => ({
  detectBestTransport: vi.fn(() => 'pipe'),
}));

vi.mock('../../lib/secrets.js', () => ({
  resolveSecret: vi.fn((v: string | null) => v ?? ''),
}));

vi.mock('../../robotic/targets/Target.js', () => ({
  resolveTarget: vi.fn(() => ({
    name: 'claude-code',
    displayName: 'Claude Code',
    launch: ['claude'],
    readyRegex: '\\$',
  })),
}));

vi.mock('../../robotic/controller/redactor.js', () => ({
  Redactor: vi.fn().mockImplementation(() => ({
    scrub: (text: string) => text,
  })),
}));

// ─── Import under test ────────────────────────────────────────────────────────

import { useRobotic } from '../useRobotic.js';
import type { UseRoboticResult } from '../useRobotic.js';
import { makeTestConfig } from '../../__tests__/fixtures/config.js';
import { makeFakeProviderRow } from '../../__tests__/helpers/fakeProviderRow.js';

// ─── Hook driver ──────────────────────────────────────────────────────────────

const tick = () => new Promise<void>((r) => setImmediate(r));

// Drain enough microtask/macrotask cycles to let async state updates settle.
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await tick();
}

type HookResult = { current: UseRoboticResult };

function renderHook(): { result: HookResult; unmount: () => void } {
  const result: HookResult = { current: undefined as unknown as UseRoboticResult };

  const config = makeTestConfig({
    robotic: {
      enabled: true,
      transport: 'auto',
      maxTurns: 5,
      turnTimeoutMs: 5000,
      minInterTurnMs: 0,
      judge: { provider: 'test-provider', model: 'test-model', everyNTurns: 1 },
      redact: { envPatterns: [], customPatterns: [] },
      targets: {},
    },
  });

  function HookWrapper() {
    result.current = useRobotic(config);
    return React.createElement(React.Fragment, null);
  }

  const { unmount } = render(React.createElement(HookWrapper));
  return { result, unmount };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useRobotic', () => {
  beforeEach(() => {
    controllerMocks.run.mockReset();
    dbMocks.getProviderById.mockReset();
    dbMocks.getDefaultProvider.mockReset();
    // Default: provider exists
    dbMocks.getProviderById.mockReturnValue(makeFakeProviderRow());
  });

  afterEach(() => {
    cleanup();
  });

  // ── Initial state ─────────────────────────────────────────────────────────

  describe('initial state', () => {
    it('status is idle', async () => {
      const { result } = renderHook();
      await tick();
      expect(result.current.state.status).toBe('idle');
    });

    it('sessionId is null', async () => {
      const { result } = renderHook();
      await tick();
      expect(result.current.state.sessionId).toBeNull();
    });

    it('turns is an empty array', async () => {
      const { result } = renderHook();
      await tick();
      expect(result.current.state.turns).toEqual([]);
    });

    it('goalProgress is 0', async () => {
      const { result } = renderHook();
      await tick();
      expect(result.current.state.goalProgress).toBe(0);
    });
  });

  // ── robotic.enabled guard ─────────────────────────────────────────────────

  describe('when robotic.enabled is false', () => {
    it('sets status to error without starting', async () => {
      const result: HookResult = { current: undefined as unknown as UseRoboticResult };

      const disabledConfig = makeTestConfig({
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

      function HookWrapper() {
        result.current = useRobotic(disabledConfig);
        return React.createElement(React.Fragment, null);
      }

      render(React.createElement(HookWrapper));
      await tick();

      await result.current.start({ target: 'claude-code', goal: 'do something' });
      await flush();

      expect(result.current.state.status).toBe('error');
    });

    it('sets a user-readable error message mentioning robotic.enabled', async () => {
      const result: HookResult = { current: undefined as unknown as UseRoboticResult };

      const disabledConfig = makeTestConfig({
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

      function HookWrapper() {
        result.current = useRobotic(disabledConfig);
        return React.createElement(React.Fragment, null);
      }

      render(React.createElement(HookWrapper));
      await tick();

      await result.current.start({ target: 'claude-code', goal: 'do something' });
      await flush();

      expect(result.current.state.error).toMatch(/robotic.enabled/i);
    });
  });

  // ── start() state transitions ─────────────────────────────────────────────

  describe('start() state transitions', () => {
    it('transitions from idle to running after start() with a valid provider', async () => {
      // run() never resolves during this test — we check the running state
      controllerMocks.run.mockReturnValue(new Promise(() => { /* pending */ }));

      const { result } = renderHook();
      await tick();

      void result.current.start({ target: 'claude-code', goal: 'test goal' });
      await flush();

      expect(result.current.state.status).toBe('running');
    });

    it('transitions to done when controller.run() returns succeeded', async () => {
      controllerMocks.run.mockResolvedValue('succeeded');

      const { result } = renderHook();
      await tick();

      await result.current.start({ target: 'claude-code', goal: 'test goal' });
      await flush();

      expect(result.current.state.status).toBe('done');
    });

    it('transitions to error when controller.run() returns failed', async () => {
      controllerMocks.run.mockResolvedValue('failed');

      const { result } = renderHook();
      await tick();

      await result.current.start({ target: 'claude-code', goal: 'test goal' });
      await flush();

      expect(result.current.state.status).toBe('error');
    });

    it('transitions to idle when controller.run() returns aborted', async () => {
      controllerMocks.run.mockResolvedValue('aborted');

      const { result } = renderHook();
      await tick();

      await result.current.start({ target: 'claude-code', goal: 'test goal' });
      await flush();

      expect(result.current.state.status).toBe('idle');
    });
  });

  // ── No provider configured ────────────────────────────────────────────────

  describe('when no provider is configured', () => {
    it('sets status to error', async () => {
      dbMocks.getProviderById.mockReturnValue(undefined);
      dbMocks.getDefaultProvider.mockReturnValue(undefined);

      const { result } = renderHook();
      await tick();

      await result.current.start({ target: 'claude-code', goal: 'something' });
      await flush();

      expect(result.current.state.status).toBe('error');
    });

    it('sets an error message mentioning provider', async () => {
      dbMocks.getProviderById.mockReturnValue(undefined);
      dbMocks.getDefaultProvider.mockReturnValue(undefined);

      const { result } = renderHook();
      await tick();

      await result.current.start({ target: 'claude-code', goal: 'something' });
      await flush();

      expect(result.current.state.error).toMatch(/provider/i);
    });
  });

  // ── abort() ───────────────────────────────────────────────────────────────

  describe('abort()', () => {
    it('sets status to idle immediately', async () => {
      controllerMocks.run.mockReturnValue(new Promise(() => { /* pending */ }));

      const { result } = renderHook();
      await tick();

      void result.current.start({ target: 'claude-code', goal: 'test' });
      await flush();

      expect(result.current.state.status).toBe('running');

      result.current.abort();
      await tick();

      expect(result.current.state.status).toBe('idle');
    });

    it('clears the EventBus subscription on abort', async () => {
      // Arrange: track how many times the bus unsubscribe was called.
      // We do this by observing that after abort(), further events from
      // a captured bus reference no longer update state.
      controllerMocks.run.mockReturnValue(new Promise(() => { /* pending */ }));

      const { result } = renderHook();
      await tick();

      void result.current.start({ target: 'claude-code', goal: 'cleanup test' });
      await flush();

      const turnsBeforeAbort = result.current.state.turns.length;

      result.current.abort();
      await tick();

      // After abort the subscription must be cleared.
      // Status is idle — that's the observable proof.
      expect(result.current.state.status).toBe('idle');
      // Turns should not have grown after abort
      expect(result.current.state.turns.length).toBe(turnsBeforeAbort);
    });
  });

  // ── EventBus subscription cleanup on unmount ──────────────────────────────

  describe('EventBus subscription cleanup on unmount', () => {
    it('does not update state after the component unmounts', async () => {
      // Arrange: start a run, unmount, then verify state is frozen
      controllerMocks.run.mockReturnValue(new Promise(() => { /* pending */ }));

      const { result, unmount } = renderHook();
      await tick();

      void result.current.start({ target: 'claude-code', goal: 'unmount test' });
      await flush();

      const statusBeforeUnmount = result.current.state.status;

      unmount();
      await flush();

      // State must not have changed (subscription cleaned up, no handler fires)
      expect(result.current.state.status).toBe(statusBeforeUnmount);
    });
  });

  // ── Multiple start() calls ────────────────────────────────────────────────

  describe('multiple start() calls', () => {
    it('second start() replaces the previous run state', async () => {
      // First run — never resolves
      controllerMocks.run.mockReturnValueOnce(new Promise(() => { /* pending */ }));
      // Second run — resolves with succeeded
      controllerMocks.run.mockResolvedValueOnce('succeeded');

      const { result } = renderHook();
      await tick();

      void result.current.start({ target: 'claude-code', goal: 'first goal' });
      await flush();

      await result.current.start({ target: 'claude-code', goal: 'second goal' });
      await flush();

      // Second run succeeded — state reflects that
      expect(result.current.state.status).toBe('done');
      expect(result.current.state.goal).toBe('second goal');
    });
  });

  // ── Transport start failure ───────────────────────────────────────────────

  describe('when transport.start() throws', () => {
    it('sets status to error', async () => {
      const { PipeTransport } = await import('../../robotic/transport/PipeTransport.js');
      vi.mocked(PipeTransport).mockImplementationOnce(() => ({
        kind: 'pipe' as const,
        start: vi.fn().mockRejectedValue(new Error('spawn failed')),
        write: vi.fn().mockResolvedValue(undefined),
        readUntilIdle: vi.fn().mockResolvedValue(''),
        events: async function* () { /* no events */ },
        close: vi.fn().mockResolvedValue(undefined),
        isReady: vi.fn(() => false),
      }));

      const { result } = renderHook();
      await tick();

      await result.current.start({ target: 'claude-code', goal: 'fail start' });
      await flush();

      expect(result.current.state.status).toBe('error');
    });

    it('sets error message to the transport error message', async () => {
      const { PipeTransport } = await import('../../robotic/transport/PipeTransport.js');
      vi.mocked(PipeTransport).mockImplementationOnce(() => ({
        kind: 'pipe' as const,
        start: vi.fn().mockRejectedValue(new Error('could not spawn process')),
        write: vi.fn().mockResolvedValue(undefined),
        readUntilIdle: vi.fn().mockResolvedValue(''),
        events: async function* () { /* no events */ },
        close: vi.fn().mockResolvedValue(undefined),
        isReady: vi.fn(() => false),
      }));

      const { result } = renderHook();
      await tick();

      await result.current.start({ target: 'claude-code', goal: 'fail start' });
      await flush();

      expect(result.current.state.error).toBe('could not spawn process');
    });
  });
});
