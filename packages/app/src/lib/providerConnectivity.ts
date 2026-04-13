import type { AuthMode } from '@uplnk/providers';

export const PROVIDER_CONNECTIVITY_POLL_MS = 15_000;
export const PROVIDER_CONNECTIVITY_TIMEOUT_MS = 5_000;
export const PROVIDER_STALE_DISCONNECT_MS = 2 * 60 * 1000;

export type ProviderConnectionPhase =
  | 'checking'
  | 'connected'
  | 'disconnected'
  | 'stale-disconnected';

export interface ProviderConnectionSnapshot {
  host: string;
  connected: boolean;
  checkedAt: number | null;
  latencyMs: number | null;
  disconnectedSince: number | null;
  errorDetail: string | null;
}

export interface ProviderConnectionDisplay {
  phase: ProviderConnectionPhase;
  color: string;
  label: string;
  detail: string;
}

export function inferProviderAuthMode(providerType: string): AuthMode {
  switch (providerType) {
    case 'anthropic':
      return 'api-key';
    case 'openai':
    case 'openai-compatible':
    case 'vllm':
    case 'custom':
      return 'bearer';
    default:
      return 'none';
  }
}

export function getProviderHost(baseURL: string): string {
  try {
    return new URL(baseURL).host;
  } catch {
    return baseURL.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
}

export function formatDurationShort(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) return `${String(seconds)}s`;
  if (minutes < 60) return `${String(minutes)}m ${String(seconds)}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${String(hours)}h ${String(remainingMinutes)}m`;
}

function compactDetail(host: string, errorDetail: string | null): string {
  if (errorDetail === null || errorDetail.trim() === '') return host;
  return `${host} · ${errorDetail.replace(/\s+/g, ' ').trim()}`;
}

export function buildProviderConnectionDisplay(
  snapshot: ProviderConnectionSnapshot,
  now = Date.now(),
): ProviderConnectionDisplay {
  if (!snapshot.connected && snapshot.checkedAt === null) {
    return {
      phase: 'checking',
      color: '#F59E0B',
      label: 'server checking…',
      detail: snapshot.host,
    };
  }

  if (snapshot.connected) {
    return {
      phase: 'connected',
      color: '#22C55E',
      label: snapshot.latencyMs !== null
        ? `server connected · ${String(snapshot.latencyMs)}ms`
        : 'server connected',
      detail: snapshot.host,
    };
  }

  const disconnectedForMs = now - (snapshot.disconnectedSince ?? now);
  const stale = disconnectedForMs >= PROVIDER_STALE_DISCONNECT_MS;
  return {
    phase: stale ? 'stale-disconnected' : 'disconnected',
    color: stale ? '#EF4444' : '#F59E0B',
    label: `${stale ? 'server offline' : 'server disconnected'} · ${formatDurationShort(disconnectedForMs)}`,
    detail: compactDetail(snapshot.host, snapshot.errorDetail),
  };
}
