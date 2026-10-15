// @vitest-environment jsdom
/**
 * useProviderConnectivity — autoLaunchOllama behavior.
 *
 * Validates the integration between the FSM, the lifecycle layer, and the
 * 60s debounce. We mock both `@uplnk/providers` (listModels) and the
 * lifecycle module (launchOllama) so no real network or processes happen.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  PROVIDER_CONNECTIVITY_POLL_MS,
} from '../../lib/providerConnectivity.js';
import {
  OLLAMA_AUTOLAUNCH_DEBOUNCE_MS,
} from '../useProviderConnectivity.js';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const providerMocks = vi.hoisted(() => ({
  listModels: vi.fn(async () => [{ id: 'llama3', name: 'llama3' }]),
}));
vi.mock('@uplnk/providers', () => ({
  makeProvider: () => ({ listModels: providerMocks.listModels }),
}));

// Use a permissive return type so individual tests can mock different
// OllamaLaunchOutcome variants without TS narrowing locking us in.
const lifecycleMocks = vi.hoisted(() => {
  type Outcome =
    | { status: 'started'; pid: number; reachableAfterMs: number }
    | { status: 'already-running' }
    | { status: 'not-installed' }
    | { status: 'launch-failed'; error: string }
    | { status: 'unreachable-after-launch'; pid: number };
  const launchOllama = vi.fn<() => Promise<Outcome>>(async () => ({
    status: 'already-running',
  }));
  return { launchOllama };
});
vi.mock('../../lib/ollamaLifecycle.js', () => ({
  launchOllama: lifecycleMocks.launchOllama,
}));

import { useProviderConnectivity } from '../useProviderConnectivity.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const OLLAMA_INPUT = {
  providerType: 'ollama',
  baseURL: 'http://localhost:11434',
  apiKey: '',
  authMode: 'none' as const,
};

function makeSuccess(): void {
  providerMocks.listModels.mockImplementation(async () => [
    { id: 'llama3', name: 'llama3' },
  ]);
}

function makeFailure(message = 'connect ECONNREFUSED'): void {
  providerMocks.listModels.mockImplementation(async () => {
    throw new Error(message);
  });
}

async function settleProbe(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
    }
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settleProbe();
}

beforeEach(() => {
  vi.useFakeTimers();
  providerMocks.listModels.mockReset();
  lifecycleMocks.launchOllama.mockReset();
  makeSuccess();
  lifecycleMocks.launchOllama.mockImplementation(async () => ({
    status: 'already-running',
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useProviderConnectivity auto-launch', () => {
  it('fires launchOllama once on the healthy→degraded edge when autoLaunch is on', async () => {
    // First probe healthy so the hook records "had healthy".
    makeSuccess();
    const { result } = renderHook(() =>
      useProviderConnectivity({ ...OLLAMA_INPUT, autoLaunchOllama: true }),
    );
    await settleProbe();
    expect(result.current.connected).toBe(true);

    // Now flip to failing — the next probe takes us healthy→degraded.
    makeFailure();
    await advance(PROVIDER_CONNECTIVITY_POLL_MS);
    expect(result.current.connected).toBe(false);
    expect(lifecycleMocks.launchOllama).toHaveBeenCalledTimes(1);
  });

  it('never fires launchOllama when autoLaunchOllama is false', async () => {
    makeFailure();
    renderHook(() => useProviderConnectivity({ ...OLLAMA_INPUT, autoLaunchOllama: false }));
    await settleProbe();
    await advance(PROVIDER_CONNECTIVITY_POLL_MS);
    await advance(PROVIDER_CONNECTIVITY_POLL_MS);
    expect(lifecycleMocks.launchOllama).not.toHaveBeenCalled();
  });

  it('debounces repeat launches within 60s', async () => {
    makeSuccess();
    renderHook(() =>
      useProviderConnectivity({ ...OLLAMA_INPUT, autoLaunchOllama: true }),
    );
    await settleProbe();

    // First failure → launch.
    makeFailure();
    await advance(PROVIDER_CONNECTIVITY_POLL_MS);
    expect(lifecycleMocks.launchOllama).toHaveBeenCalledTimes(1);

    // Hook will sit in cooldown after consecutive failures; even if we re-enter
    // degraded later it must not relaunch inside the debounce window. Walk
    // ~30s and verify no second call.
    await advance(30_000);
    expect(lifecycleMocks.launchOllama).toHaveBeenCalledTimes(1);
  });

  it('successful launch nudges the FSM into an immediate re-probe', async () => {
    // Start healthy → degraded so launchOllama actually runs.
    makeSuccess();
    renderHook(() =>
      useProviderConnectivity({ ...OLLAMA_INPUT, autoLaunchOllama: true }),
    );
    await settleProbe();

    makeFailure();
    await advance(PROVIDER_CONNECTIVITY_POLL_MS);
    const callsBefore = providerMocks.listModels.mock.calls.length;
    expect(lifecycleMocks.launchOllama).toHaveBeenCalledTimes(1);

    // The launch outcome is 'already-running' which should accelerate the
    // next probe (setTimeout 0). Flush microtasks for the launch IIFE to
    // resolve, then advance fake timers past the 0-delay setTimeout.
    makeSuccess();
    await settleProbe();
    await advance(1);
    expect(providerMocks.listModels.mock.calls.length).toBeGreaterThan(callsBefore);
    // And the accelerated probe should NOT have waited the FSM cooldown.
    // (Sanity: by 1ms in we definitely have not crossed 20s cooldown.)
  });

  it("surfaces ollamaInstalled='missing' when launchOllama reports not-installed", async () => {
    lifecycleMocks.launchOllama.mockImplementation(async () => ({
      status: 'not-installed',
    }));

    makeSuccess();
    const { result } = renderHook(() =>
      useProviderConnectivity({ ...OLLAMA_INPUT, autoLaunchOllama: true }),
    );
    await settleProbe();

    makeFailure();
    await advance(PROVIDER_CONNECTIVITY_POLL_MS);
    // Flush the lifecycle promise.
    await settleProbe();

    expect(result.current.ollamaInstalled).toBe('missing');
    expect(result.current.lastLaunchOutcome).toEqual({ status: 'not-installed' });
  });

  it('never fires for a non-ollama provider even with autoLaunch on', async () => {
    makeSuccess();
    renderHook(() =>
      useProviderConnectivity({
        providerType: 'openai-compatible',
        baseURL: 'http://api.example.com:8080/v1',
        apiKey: 'sk-test',
        authMode: 'bearer' as const,
        autoLaunchOllama: true,
      }),
    );
    await settleProbe();

    makeFailure();
    await advance(PROVIDER_CONNECTIVITY_POLL_MS);
    await advance(PROVIDER_CONNECTIVITY_POLL_MS);
    expect(lifecycleMocks.launchOllama).not.toHaveBeenCalled();
  });

  it('uses the documented 60_000ms debounce constant', () => {
    expect(OLLAMA_AUTOLAUNCH_DEBOUNCE_MS).toBe(60_000);
  });
});
