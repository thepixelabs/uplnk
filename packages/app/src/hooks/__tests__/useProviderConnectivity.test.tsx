// @vitest-environment jsdom
/**
 * useProviderConnectivity — failure backoff + recovery contract.
 *
 * Drives the hook with vi.useFakeTimers() and a fake `listModels` whose
 * resolved/rejected outcome we flip between ticks. Validates the polling
 * cadence prescribed by `nextConnectivityState`:
 *   - clean success keeps 15s polling
 *   - threshold failures switch to 20s base, doubling, capping at 60s
 *   - any success resets immediately to 15s
 *   - existing 2-minute stale-disconnect display still fires
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  PROVIDER_CONNECTIVITY_POLL_MS,
  PROVIDER_COOLDOWN_BASE_MS,
  PROVIDER_COOLDOWN_MAX_MS,
  PROVIDER_STALE_DISCONNECT_MS,
  buildProviderConnectionDisplay,
} from '../../lib/providerConnectivity.js';

// ─── Hoisted fake provider ────────────────────────────────────────────────────

const providerMocks = vi.hoisted(() => {
  const listModels = vi.fn(async () => [{ id: 'fake-model', name: 'Fake Model' }]);
  return { listModels };
});

vi.mock('@uplnk/providers', () => ({
  makeProvider: () => ({
    listModels: providerMocks.listModels,
  }),
}));

import { useProviderConnectivity } from '../useProviderConnectivity.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const INPUT = {
  providerType: 'ollama',
  baseURL: 'http://localhost:11434',
  apiKey: '',
  authMode: 'none' as const,
};

function makeSuccess(): void {
  providerMocks.listModels.mockImplementation(async () => [
    { id: 'fake-model', name: 'Fake Model' },
  ]);
}

function makeFailure(message = 'connect ECONNREFUSED'): void {
  providerMocks.listModels.mockImplementation(async () => {
    throw new Error(message);
  });
}

/**
 * Run all pending microtasks + the timer at exactly `ms` ahead. We loop because
 * each probe runs an async listModels() that must settle before its `finally`
 * scheduleNextCheck() registers the next timer.
 */
async function settleProbe(): Promise<void> {
  // Let the in-flight listModels promise resolve/reject and its finally run.
  // A handful of microtask flushes covers: provider construction, listModels
  // await, setState callback, and the scheduleNextCheck call in finally.
  await act(async () => {
    for (let i = 0; i < 8; i++) {
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useProviderConnectivity backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    providerMocks.listModels.mockReset();
    makeSuccess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps polling at 15s while every probe succeeds', async () => {
    const { result } = renderHook(() => useProviderConnectivity(INPUT));

    // Initial probe.
    await settleProbe();
    expect(result.current.connected).toBe(true);
    const callsAfterInit = providerMocks.listModels.mock.calls.length;
    expect(callsAfterInit).toBe(1);

    // Tick well below the poll interval — no new probe yet.
    await advance(PROVIDER_CONNECTIVITY_POLL_MS - 1_000);
    expect(providerMocks.listModels.mock.calls.length).toBe(callsAfterInit);

    // Cross the poll boundary — exactly one more probe.
    await advance(1_000);
    expect(providerMocks.listModels.mock.calls.length).toBe(callsAfterInit + 1);
    expect(result.current.connected).toBe(true);
  });

  it('stays at 15s after a single failure (degraded)', async () => {
    makeFailure();
    const { result } = renderHook(() => useProviderConnectivity(INPUT));
    await settleProbe();
    expect(result.current.connected).toBe(false);
    expect(providerMocks.listModels.mock.calls.length).toBe(1);

    // Below 15s threshold → no new probe.
    await advance(PROVIDER_CONNECTIVITY_POLL_MS - 1_000);
    expect(providerMocks.listModels.mock.calls.length).toBe(1);

    // Cross 15s → second probe (still a failure).
    await advance(1_000);
    expect(providerMocks.listModels.mock.calls.length).toBe(2);
  });

  it('switches to 20s cooldown after the second consecutive failure', async () => {
    makeFailure();
    const { result } = renderHook(() => useProviderConnectivity(INPUT));
    await settleProbe();
    expect(providerMocks.listModels.mock.calls.length).toBe(1);

    // Probe #2 at the 15s tick (still degraded → cooldown after this one).
    await advance(PROVIDER_CONNECTIVITY_POLL_MS);
    expect(providerMocks.listModels.mock.calls.length).toBe(2);

    // Next scheduled probe should be at PROVIDER_COOLDOWN_BASE_MS (20s),
    // not 15s. Verify nothing fires before that.
    await advance(PROVIDER_CONNECTIVITY_POLL_MS);
    expect(providerMocks.listModels.mock.calls.length).toBe(2);

    // Now advance the remainder to hit 20s.
    await advance(PROVIDER_COOLDOWN_BASE_MS - PROVIDER_CONNECTIVITY_POLL_MS);
    expect(providerMocks.listModels.mock.calls.length).toBe(3);
    expect(result.current.connected).toBe(false);
  });

  it('doubles cooldown to 40s on the third consecutive failure', async () => {
    makeFailure();
    renderHook(() => useProviderConnectivity(INPUT));
    await settleProbe(); // probe #1

    await advance(PROVIDER_CONNECTIVITY_POLL_MS); // probe #2 (-> cooldown)
    await advance(PROVIDER_COOLDOWN_BASE_MS);     // probe #3 (cooldown, 20s wait)
    expect(providerMocks.listModels.mock.calls.length).toBe(3);

    // The next probe should be 40s away. 39s → nothing.
    await advance(PROVIDER_COOLDOWN_BASE_MS * 2 - 1_000);
    expect(providerMocks.listModels.mock.calls.length).toBe(3);

    // Cross to 40s → probe #4.
    await advance(1_000);
    expect(providerMocks.listModels.mock.calls.length).toBe(4);
  });

  it('caps cooldown at 60s for sustained failure', async () => {
    makeFailure();
    renderHook(() => useProviderConnectivity(INPUT));
    await settleProbe(); // #1

    // Failures 2..5 push exponent through 0,1,2 → next delay 20,40,60.
    await advance(PROVIDER_CONNECTIVITY_POLL_MS); // #2 (now cooldown, next 20s)
    await advance(PROVIDER_COOLDOWN_BASE_MS);     // #3 (next 40s)
    await advance(PROVIDER_COOLDOWN_BASE_MS * 2); // #4 (next 60s capped)
    await advance(PROVIDER_COOLDOWN_MAX_MS);      // #5 (next still 60s)
    expect(providerMocks.listModels.mock.calls.length).toBe(5);

    // Verify cap holds: nothing fires before 60s, exactly one probe at 60s.
    await advance(PROVIDER_COOLDOWN_MAX_MS - 1_000);
    expect(providerMocks.listModels.mock.calls.length).toBe(5);
    await advance(1_000);
    expect(providerMocks.listModels.mock.calls.length).toBe(6);
  });

  it('resets to healthy + 15s polling on success during cooldown', async () => {
    makeFailure();
    const { result } = renderHook(() => useProviderConnectivity(INPUT));
    await settleProbe();                          // #1 fail
    await advance(PROVIDER_CONNECTIVITY_POLL_MS); // #2 fail → cooldown

    // Recover before #3.
    makeSuccess();
    await advance(PROVIDER_COOLDOWN_BASE_MS);     // #3 succeeds
    expect(result.current.connected).toBe(true);

    const callsAfterRecover = providerMocks.listModels.mock.calls.length;

    // After recovery, next probe should be the steady 15s, not a leftover
    // 40s cooldown delay.
    await advance(PROVIDER_CONNECTIVITY_POLL_MS - 1_000);
    expect(providerMocks.listModels.mock.calls.length).toBe(callsAfterRecover);
    await advance(1_000);
    expect(providerMocks.listModels.mock.calls.length).toBe(callsAfterRecover + 1);
  });

  it('flips display to stale-disconnected once the outage exceeds 2 minutes', async () => {
    makeFailure();
    const { result } = renderHook(() => useProviderConnectivity(INPUT));
    await settleProbe();
    const disconnectedAt = result.current.disconnectedSince;
    expect(disconnectedAt).not.toBeNull();

    // Walk forward past the stale threshold (the polls in between are still
    // backed-off failures — that's fine; the display layer only cares about
    // `disconnectedSince`).
    await advance(PROVIDER_STALE_DISCONNECT_MS + 1_000);
    expect(result.current.connected).toBe(false);

    const display = buildProviderConnectionDisplay(
      {
        host: result.current.host,
        connected: result.current.connected,
        checkedAt: result.current.checkedAt,
        latencyMs: result.current.latencyMs,
        disconnectedSince: result.current.disconnectedSince,
        errorDetail: result.current.errorDetail,
      },
      (disconnectedAt ?? 0) + PROVIDER_STALE_DISCONNECT_MS + 5_000,
    );
    expect(display.phase).toBe('stale-disconnected');
  });
});
