import { isServer } from '@pantry-host/shared/env';

/**
 * Checks whether the current hostname belongs to a trusted local or VPN network.
 * Used to gate owner-only features (e.g. cookware management) when not behind HTTPS.
 *
 * Trusted networks:
 *  - localhost / 127.0.0.1
 *  - LAN mDNS (.local)
 *  - Private IP ranges (10.x, 192.168.x)
 *  - Tailscale CGNAT range (100.64–127.x) and MagicDNS (.ts.net)
 */
export function isTrustedNetwork(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  if (hostname.endsWith('.local')) return true;
  if (hostname.endsWith('.ts.net')) return true;
  if (hostname.startsWith('192.168.')) return true;
  if (hostname.startsWith('10.')) return true;

  // Tailscale uses CGNAT range 100.64.0.0/10 (100.64.x.x – 100.127.x.x)
  if (hostname.startsWith('100.')) {
    const second = parseInt(hostname.split('.')[1], 10);
    if (second >= 64 && second <= 127) return true;
  }

  return false;
}

/**
 * Determines if the current user has owner-level access.
 *
 * Always-owner: `localhost`, `127.0.0.1`, or HTTPS (Tailscale cert,
 * mkcert, etc.).
 *
 * Opt-in: if the server emits `<meta name="trust-lan" content="true">`
 * in the SPA shell, any hostname that `isTrustedNetwork()` recognizes
 * (`.local` mDNS, `.ts.net` MagicDNS, RFC1918 LAN, Tailscale CGNAT)
 * also counts as owner. The Rust binary emits that meta tag when its
 * `PANTRY_TRUST_LAN=true` env var is set — the single-user-home-server
 * posture for Pi deployments. Default is off so the Rex dev server
 * exposed over LAN stays read-only for guests.
 */
export function isOwner(): boolean {
  if (isServer) return false;
  if (window.location.protocol === 'https:') return true;
  const h = window.location.hostname;
  if (h === 'localhost' || h === '127.0.0.1') return true;
  const meta = document.querySelector('meta[name="trust-lan"]');
  if (meta?.getAttribute('content') === 'true' && isTrustedNetwork(h)) return true;
  return false;
}
