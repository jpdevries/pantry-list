//! Auth-aware fetch helpers for the settings + recipe-api-key tests.
//!
//! settings-read / settings-write / recipe-api-key gate on the `Host`
//! request header (loopback => owner, anything else => guest). The Fetch
//! spec marks `Host` as a forbidden request header, so we can't spoof
//! it. Instead, the guest helper hits the server via `127.0.0.2`, which
//! is still on `lo0` (kernel routes the entire 127/8 to loopback), but
//! the URL's host string is *not* one of the literal strings the server
//! treats as loopback (`localhost`, `127.0.0.1`, `::1`). The default
//! Host header becomes `127.0.0.2:<port>` and `is_owner()` returns false.

import { harness } from './harness.ts';

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface RawOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

async function send(originUrl: string, path: string, init: RawOptions): Promise<RawResponse> {
  const res = await fetch(`${originUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body,
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return {
    status: res.status,
    headers,
    body: await res.text(),
  };
}

/** Owner request: harness URL hits 127.0.0.1, which `is_owner()` matches. */
export function fetchAsOwner(path: string, init: RawOptions = {}): Promise<RawResponse> {
  return send(harness().url, path, init);
}

/** Guest request: swap 127.0.0.1 for 127.0.0.2 so the Host header
 *  becomes a non-loopback string, while the connection still lands on
 *  the same lo0 socket (the entire 127/8 is loopback on Linux+macOS). */
export function fetchAsGuest(path: string, init: RawOptions = {}): Promise<RawResponse> {
  const guestUrl = harness().url.replace('://127.0.0.1', '://127.0.0.2');
  return send(guestUrl, path, init);
}

export function parseJson<T = unknown>(res: RawResponse): T {
  return JSON.parse(res.body) as T;
}
