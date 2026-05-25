export type IntegrationState =
  | { state: 'not_configured' }
  | { state: 'awaiting_auth'; auth_url: string }
  | { state: 'connecting' }
  | { state: 'connected'; label: string }
  | { state: 'skipped' }
  | { state: 'unavailable'; reason: string };

export interface SetupStatus {
  complete: boolean;
  integrations: {
    tailscale: IntegrationState;
    bluesky: IntegrationState;
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.status === 204 ? (undefined as T) : (r.json() as Promise<T>);
}

export type TailscaleState =
  | { state: 'unavailable'; reason: string }
  | { state: 'not_connected' }
  | { state: 'awaiting_auth'; auth_url: string }
  | { state: 'connected_no_serve'; tailnet: string }
  | { state: 'configured'; url: string; tailnet: string };

export type BlueskyState =
  | { state: 'not_configured' }
  | { state: 'configured'; handle: string; did: string };

export const api = {
  getSetupStatus: () => request<SetupStatus>('/api/setup-status'),
  finishSetup: () => request<void>('/api/setup-complete', { method: 'POST', body: '{}' }),
  resetSetup: () => request<void>('/api/setup-complete', { method: 'POST', body: JSON.stringify({ reset: true }) }),
  getTailscaleStatus: () => request<TailscaleState>('/api/tailscale/status'),
  connectTailscale: () => request<TailscaleState>('/api/tailscale/connect', { method: 'POST', body: '{}' }),
  enableTailscaleServe: () => request<TailscaleState>('/api/tailscale/enable-serve', { method: 'POST', body: '{}' }),
  getBlueskyStatus: () => request<BlueskyState>('/api/bluesky/status'),
  connectBluesky: (handle: string) =>
    request<BlueskyState>('/api/bluesky/connect', {
      method: 'POST',
      body: JSON.stringify({ handle }),
    }),
  disconnectBluesky: () => request<BlueskyState>('/api/bluesky/disconnect', { method: 'POST', body: '{}' }),
};
