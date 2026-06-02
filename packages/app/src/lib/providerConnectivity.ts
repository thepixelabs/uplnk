import type { AuthMode } from '@uplnk/providers';

export const PROVIDER_CONNECTIVITY_POLL_MS = 15_000;
export const PROVIDER_CONNECTIVITY_TIMEOUT_MS = 5_000;
export const PROVIDER_STALE_DISCONNECT_MS = 2 * 60 * 1000;

export type ProviderConnectionPhase =
  | 'checking'
  | 'connected'
  | 'model-missing'
  | 'disconnected'
  | 'stale-disconnected';

export interface ProviderConnectionSnapshot {
  host: string;
  connected: boolean;
  checkedAt: number | null;
  latencyMs: number | null;
  disconnectedSince: number | null;
  errorDetail: string | null;
  /** Lowercased ids of models the server reports. `null` = not yet probed. */
  installedModelIds?: ReadonlySet<string> | null;
  /**
   * Lowercased id of the model the chat is configured to use. When provided
   * AND a model list is available, the display switches the label/colour to
   * reflect model availability instead of just server reachability.
   */
  activeModelId?: string | null;
}

export interface ProviderConnectionDisplay {
  phase: ProviderConnectionPhase;
  color: string;
  label: string;
  detail: string;
}

export function inferProviderAuthMode(providerType: string): AuthMode {
  switch (providerType) {
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
    // Server up + we know the model list + active model isn't on it →
    // surface the mismatch in the header so the user doesn't see "connected"
    // while their actual chat fails. Without an activeModelId, fall through
    // to the plain "server connected" label (existing behaviour preserved).
    if (
      snapshot.activeModelId !== undefined &&
      snapshot.activeModelId !== null &&
      snapshot.installedModelIds !== undefined &&
      snapshot.installedModelIds !== null
    ) {
      const present = snapshot.installedModelIds.has(snapshot.activeModelId.toLowerCase());
      if (!present) {
        return {
          phase: 'model-missing',
          color: '#EF4444',
          label: 'model not installed',
          detail: `${snapshot.host} · ${snapshot.activeModelId}`,
        };
      }
    }
    return {
      phase: 'connected',
      color: '#22C55E',
      label: snapshot.latencyMs !== null
        ? `server + model ready · ${String(snapshot.latencyMs)}ms`
        : 'server + model ready',
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
