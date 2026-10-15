/**
 * PortScanScreen — unit tests.
 *
 * Strategy:
 *  - Mock `../../lib/portScan.js` so we control exactly which endpoints get
 *    yielded and when. The mock's generator function pulls from a deferred
 *    queue that the test body advances explicitly.
 *  - Keyboard interactions are driven via stdin.write().
 *  - We assert text frames and prop callbacks (onSelect/onCancel).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';

const tick = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));
const ticks = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i++) await tick();
};

// ─── Hoisted mock state ───────────────────────────────────────────────────────

interface MockEndpoint {
  url: string;
  port: number;
  kind: 'openai-compat' | 'ollama' | 'llama-cpp' | 'unknown';
  models: readonly string[];
  latencyMs: number;
}

const state = vi.hoisted(() => ({
  /** Endpoints the next streaming call will emit, in order. */
  endpoints: [] as MockEndpoint[],
  /** Captured signal so tests can verify abort. */
  lastSignal: null as AbortSignal | null,
  /** Track whether we artificially block emission (for streaming-grow test). */
  resolveEmit: null as (() => void) | null,
  /** If true, generator pauses between yields until resolveEmit is called. */
  pauseBetweenYields: false,
}));

vi.mock('../../lib/portScan.js', () => ({
  scanLocalEndpointsStreaming: vi.fn(async function* (opts?: { signal?: AbortSignal }) {
    state.lastSignal = opts?.signal ?? null;
    for (const ep of state.endpoints) {
      if (opts?.signal?.aborted) return;
      if (state.pauseBetweenYields) {
        await new Promise<void>((resolve) => {
          state.resolveEmit = resolve;
        });
      }
      if (opts?.signal?.aborted) return;
      yield ep;
    }
  }),
}));

import { PortScanScreen } from '../PortScanScreen.js';

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  state.endpoints = [];
  state.lastSignal = null;
  state.resolveEmit = null;
  state.pauseBetweenYields = false;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeEp(port: number, overrides: Partial<MockEndpoint> = {}): MockEndpoint {
  return {
    url: `http://localhost:${String(port)}`,
    port,
    kind: 'openai-compat',
    models: ['model-a'],
    latencyMs: 12,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PortScanScreen — initial render', () => {
  it('shows the scanning header and empty list', async () => {
    state.endpoints = [];
    // Don't pause — generator completes with no yields, status becomes 'done'.
    // But we want the *initial* render. Capture before tick fires.
    state.pauseBetweenYields = true;

    const { lastFrame } = render(
      React.createElement(PortScanScreen, {
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

    // Synchronously after mount: status is 'scanning', list empty.
    const frame = lastFrame();
    expect(frame).toContain('Port Scan');
    expect(frame).toContain('scanning');
    expect(frame).toContain('Probing');
  });
});

describe('PortScanScreen — streaming results', () => {
  it('grows the list as scanLocalEndpointsStreaming yields', async () => {
    state.endpoints = [makeEp(1234), makeEp(8000, { models: ['m1', 'm2'] })];
    state.pauseBetweenYields = true;

    const { lastFrame } = render(
      React.createElement(PortScanScreen, {
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

    // Release first endpoint.
    await ticks();
    state.resolveEmit?.();
    await ticks();
    expect(lastFrame()).toContain('1234');
    expect(lastFrame()).not.toContain('8000');

    // Release the second.
    state.resolveEmit?.();
    await ticks();
    expect(lastFrame()).toContain('1234');
    expect(lastFrame()).toContain('8000');
    expect(lastFrame()).toContain('2 models');
  });
});

describe('PortScanScreen — empty state', () => {
  it('shows install hints when nothing was found', async () => {
    state.endpoints = [];
    state.pauseBetweenYields = false; // generator finishes immediately

    const { lastFrame } = render(
      React.createElement(PortScanScreen, {
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    await ticks();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('No local model servers detected');
    expect(frame).toContain('brew install ollama');
    expect(frame).toContain('pip install vllm');
  });
});

describe('PortScanScreen — Enter selects highlighted endpoint', () => {
  it('calls onSelect with the cursor row', async () => {
    state.endpoints = [makeEp(1234), makeEp(8000)];
    state.pauseBetweenYields = false;
    const onSelect = vi.fn();

    const { stdin } = render(
      React.createElement(PortScanScreen, {
        onSelect,
        onCancel: vi.fn(),
      }),
    );
    await ticks();
    // Cursor starts at 0 (port 1234 once sorted ascending).
    stdin.write('\r');
    await ticks();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]?.port).toBe(1234);
  });
});

describe('PortScanScreen — Esc cancels and aborts scan', () => {
  it('fires onCancel and aborts the AbortSignal', async () => {
    state.endpoints = [];
    state.pauseBetweenYields = true; // keep generator parked so signal is observable
    const onCancel = vi.fn();

    const { stdin } = render(
      React.createElement(PortScanScreen, {
        onSelect: vi.fn(),
        onCancel,
      }),
    );
    await ticks();
    expect(state.lastSignal).not.toBeNull();
    expect(state.lastSignal?.aborted).toBe(false);

    stdin.write(''); // ESC
    await ticks();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(state.lastSignal?.aborted).toBe(true);
  });
});

describe('PortScanScreen — narrow terminal width', () => {
  it('still renders all endpoint rows', async () => {
    const originalCols = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
    try {
      state.endpoints = [makeEp(1234), makeEp(8000)];
      state.pauseBetweenYields = false;

      const { lastFrame } = render(
        React.createElement(PortScanScreen, {
          onSelect: vi.fn(),
          onCancel: vi.fn(),
        }),
      );
      await ticks();
      const frame = lastFrame() ?? '';
      expect(frame).toContain('1234');
      expect(frame).toContain('8000');
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: originalCols, configurable: true });
    }
  });
});
