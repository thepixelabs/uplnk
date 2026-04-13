import { describe, expect, it } from 'vitest';
import {
  PROVIDER_STALE_DISCONNECT_MS,
  buildProviderConnectionDisplay,
  formatDurationShort,
  getProviderHost,
  inferProviderAuthMode,
} from '../providerConnectivity.js';

describe('providerConnectivity helpers', () => {
  it('infers bearer auth for openai-compatible providers', () => {
    expect(inferProviderAuthMode('openai-compatible')).toBe('bearer');
  });

  it('infers api-key auth for anthropic', () => {
    expect(inferProviderAuthMode('anthropic')).toBe('api-key');
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
      label: 'server connected · 182ms',
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
