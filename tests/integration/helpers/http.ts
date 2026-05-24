//! Auth-aware HTTP helpers for the /api/settings-* and /api/recipe-api-key
//! tests. They need to spoof the `Host` request header to exercise both
//! the owner (loopback) and guest (LAN IP) branches.
//!
//! Fetch's spec marks `Host` as a forbidden request header, so we can't
//! use the global fetch for the guest path. node:http would accept it in
//! principle, but its keep-alive agent intermittently hangs against axum
//! in this harness. Raw node:net is the simplest thing that works:
//! we open a TCP socket, write an HTTP/1.1 request with the Host header
//! we want, send `Connection: close` so the server hangs up after the
//! response, read until EOF, and parse the head + body ourselves.

import { connect, type Socket } from 'node:net';
import { harness } from './harness.ts';

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface RawOptions {
  method?: string;
  /** Extra headers (case-insensitive keys). `host`, `content-length`,
   *  and `connection` are managed by the helper. */
  headers?: Record<string, string>;
  body?: string;
}

const OWNER_HOST = '127.0.0.1';
// A non-loopback hostname for the guest path. The actual TCP connection
// still lands on 127.0.0.1 (we set hostname for the socket separately);
// only the HTTP Host header carries this string.
const GUEST_HOST_HEADER = '192.168.1.50';

async function rawRequest(spoofHost: string, path: string, init: RawOptions): Promise<RawResponse> {
  const { url } = harness();
  const parsed = new URL(url);
  const port = Number(parsed.port);
  const method = (init.method ?? 'GET').toUpperCase();

  const headers = new Map<string, string>();
  for (const [k, v] of Object.entries(init.headers ?? {})) {
    headers.set(k.toLowerCase(), v);
  }
  // The Host header is what we're trying to control; ignore any caller
  // attempt to set it via init.headers and override with spoofHost.
  headers.set('host', `${spoofHost}:${port}`);
  headers.set('connection', 'close');
  if (init.body !== undefined) {
    headers.set('content-length', String(Buffer.byteLength(init.body, 'utf8')));
  } else if (method !== 'GET' && method !== 'HEAD') {
    headers.set('content-length', '0');
  }

  const lines = [`${method} ${path} HTTP/1.1`];
  for (const [k, v] of headers) {
    lines.push(`${k}: ${v}`);
  }
  const headerBlock = lines.join('\r\n') + '\r\n\r\n';

  return new Promise<RawResponse>((resolve, reject) => {
    const socket: Socket = connect(port, OWNER_HOST);
    const chunks: Buffer[] = [];
    socket.setTimeout(10_000, () => {
      socket.destroy(new Error('TCP timeout'));
    });
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(headerBlock);
      if (init.body !== undefined) socket.write(init.body);
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('end', () => {
      try {
        resolve(parseResponse(Buffer.concat(chunks)));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function parseResponse(raw: Buffer): RawResponse {
  const sep = raw.indexOf('\r\n\r\n');
  if (sep < 0) throw new Error('Malformed response (no header/body separator)');
  const headerText = raw.subarray(0, sep).toString('utf8');
  const body = raw.subarray(sep + 4).toString('utf8');
  const [statusLine, ...headerLines] = headerText.split('\r\n');
  const m = statusLine.match(/^HTTP\/1\.[01] (\d+) /);
  if (!m) throw new Error(`Malformed status line: ${statusLine}`);
  const status = Number(m[1]);
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  // The server may have used `Transfer-Encoding: chunked` even though
  // we asked for `Connection: close`. Decode chunks if so.
  let decoded = body;
  if ((headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
    decoded = decodeChunked(body);
  }
  return { status, headers, body: decoded };
}

function decodeChunked(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const lineEnd = input.indexOf('\r\n', i);
    if (lineEnd < 0) break;
    const size = parseInt(input.slice(i, lineEnd), 16);
    if (!Number.isFinite(size) || size === 0) break;
    out += input.slice(lineEnd + 2, lineEnd + 2 + size);
    i = lineEnd + 2 + size + 2; // skip data + trailing CRLF
  }
  return out;
}

/** Owner request: Host header reads `127.0.0.1:<port>`, server's
 *  is_owner() loopback check matches. */
export function fetchAsOwner(path: string, init: RawOptions = {}): Promise<RawResponse> {
  return rawRequest(OWNER_HOST, path, init);
}

/** Guest request: Host header reads `192.168.1.50:<port>` — non-loopback,
 *  no X-Forwarded-Proto, so is_owner() returns false. */
export function fetchAsGuest(path: string, init: RawOptions = {}): Promise<RawResponse> {
  return rawRequest(GUEST_HOST_HEADER, path, init);
}

export function parseJson<T = unknown>(res: RawResponse): T {
  return JSON.parse(res.body) as T;
}
