import { describe, expect, it } from 'vitest';
import {
  PROVIDER_CONNECTIVITY_POLL_MS,
  PROVIDER_COOLDOWN_BASE_MS,
  PROVIDER_COOLDOWN_MAX_MS,
  PROVIDER_FAILURE_THRESHOLD,
  PROVIDER_STALE_DISCONNECT_MS,
  buildProviderConnectionDisplay,
  formatDurationShort,
  getProviderHost,
  inferProviderAuthMode,
  nextConnectivityState,
  type ConnectivityFsmPrev,
} from '../providerConnectivity.js';

describe('providerConnectivity helpers', () => {
  it('infers bearer auth for openai-compatible providers', () => {
    expect(inferProviderAuthMode('openai-compatible')).toBe('bearer');
  });

  it('infers none auth for ollama', () => {
    expect(inferProviderAuthMode('ollama')).toBe('none');
  });

  it('extracts the host from a provider URL', () => {
    expect(getProviderHost('https://llm.example.com:8080/v1')).toBe('llm.example.com:8080');
  });

  it('formats short durations in seconds', () => {
    expect(formatDurationShort(19_000)).toBe('19s');
  });

  it('formats minute durations in minutes and seconds', () => {
    expect(formatDurationShort(125_000)).toBe('2m 5s');
  });

  it('renders a green connected display with latency', () => {
    expect(buildProviderConnectionDisplay({
      host: 'llm.example.com',
      connected: true,
      checkedAt: 1,
      latencyMs: 182,
      disconnectedSince: null,
      errorDetail: null,
    })).toEqual({
      phase: 'connected',
      color: '#22C55E',
      label: 'server + model ready · 182ms',
      detail: 'llm.example.com',
    });
  });

  it('renders an orange disconnected display before the stale threshold', () => {
    expect(buildProviderConnectionDisplay({
      host: 'llm.example.com',
      connected: false,
      checkedAt: 10,
      latencyMs: null,
      disconnectedSince: 1_000,
      errorDetail: 'connect ECONNREFUSED',
    }, 61_000)).toEqual({
      phase: 'disconnected',
      color: '#F59E0B',
      label: 'server disconnected · 1m 0s',
      detail: 'llm.example.com · connect ECONNREFUSED',
    });
  });

  it('renders a red offline display after two minutes disconnected', () => {
    expect(buildProviderConnectionDisplay({
      host: 'llm.example.com',
      connected: false,
      checkedAt: 10,
      latencyMs: null,
      disconnectedSince: 1_000,
      errorDetail: 'connect ECONNREFUSED',
    }, 1_000 + PROVIDER_STALE_DISCONNECT_MS)).toEqual({
      phase: 'stale-disconnected',
      color: '#EF4444',
      label: 'server offline · 2m 0s',
      detail: 'llm.example.com · connect ECONNREFUSED',
    });
  });
});

describe('nextConnectivityState', () => {
  const healthy: ConnectivityFsmPrev = {
    fsmState: 'healthy',
    consecutiveFailures: 0,
    disconnectedSince: null,
  };

  it('keeps healthy + 15s poll on success from healthy', () => {
    const out = nextConnectivityState(healthy, { kind: 'success', now: 1_000 });
    expect(out).toEqual({
      fsmState: 'healthy',
      consecutiveFailures: 0,
      disconnectedSince: null,
      nextPollMs: PROVIDER_CONNECTIVITY_POLL_MS,
    });
  });

  it('moves healthy → degraded on first failure, still polling at 15s', () => {
    const out = nextConnectivityState(healthy, { kind: 'failure', now: 1_000 });
    expect(out.fsmState).toBe('degraded');
    expect(out.consecutiveFailures).toBe(1);
    expect(out.disconnectedSince).toBe(1_000);
    expect(out.nextPollMs).toBe(PROVIDER_CONNECTIVITY_POLL_MS);
  });

  it('moves degraded → cooldown on second failure with 20s next poll', () => {
    const degraded: ConnectivityFsmPrev = {
      fsmState: 'degraded',
      consecutiveFailures: 1,
      disconnectedSince: 500,
    };
    const out = nextConnectivityState(degraded, { kind: 'failure', now: 16_000 });
    expect(out.fsmState).toBe('cooldown');
    expect(out.consecutiveFailures).toBe(PROVIDER_FAILURE_THRESHOLD);
    expect(out.disconnectedSince).toBe(500); // preserved
    expect(out.nextPollMs).toBe(PROVIDER_COOLDOWN_BASE_MS);
  });

  it('doubles the cooldown delay on the third failure (40s)', () => {
    const cooldown: ConnectivityFsmPrev = {
      fsmState: 'cooldown',
      consecutiveFailures: 2,
      disconnectedSince: 500,
    };
    const out = nextConnectivityState(cooldown, { kind: 'failure', now: 36_000 });
    expect(out.fsmState).toBe('cooldown');
    expect(out.consecutiveFailures).toBe(3);
    expect(out.nextPollMs).toBe(PROVIDER_COOLDOWN_BASE_MS * 2);
  });

  it('caps the cooldown delay at 60s for many consecutive failures', () => {
    const cooldown: ConnectivityFsmPrev = {
      fsmState: 'cooldown',
      consecutiveFailures: 8,
      disconnectedSince: 500,
    };
    const out = nextConnectivityState(cooldown, { kind: 'failure', now: 100_000 });
    expect(out.fsmState).toBe('cooldown');
    expect(out.consecutiveFailures).toBe(9);
    expect(out.nextPollMs).toBe(PROVIDER_COOLDOWN_MAX_MS);
  });

  it('resets to healthy + 15s on success from cooldown', () => {
    const cooldown: ConnectivityFsmPrev = {
      fsmState: 'cooldown',
      consecutiveFailures: 5,
      disconnectedSince: 500,
    };
    const out = nextConnectivityState(cooldown, { kind: 'success', now: 100_000 });
    expect(out).toEqual({
      fsmState: 'healthy',
      consecutiveFailures: 0,
      disconnectedSince: null,
      nextPollMs: PROVIDER_CONNECTIVITY_POLL_MS,
    });
  });

  it('preserves disconnectedSince across multiple failures', () => {
    let prev: ConnectivityFsmPrev = healthy;
    const firstNow = 1_000;
    const first = nextConnectivityState(prev, { kind: 'failure', now: firstNow });
    prev = {
      fsmState: first.fsmState,
      consecutiveFailures: first.consecutiveFailures,
      disconnectedSince: first.disconnectedSince,
    };
    const second = nextConnectivityState(prev, { kind: 'failure', now: 16_000 });
    const third = nextConnectivityState(
      {
        fsmState: second.fsmState,
        consecutiveFailures: second.consecutiveFailures,
        disconnectedSince: second.disconnectedSince,
      },
      { kind: 'failure', now: 36_000 },
    );
    expect(first.disconnectedSince).toBe(firstNow);
    expect(second.disconnectedSince).toBe(firstNow);
    expect(third.disconnectedSince).toBe(firstNow);
  });
});
