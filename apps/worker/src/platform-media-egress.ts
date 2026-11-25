/**
 * @file platform-media-egress.ts
 * @description Proxy-only transport for the platform media executor.
 *
 * A worker-side port of the web chat egress fetch
 * (`apps/web/src/lib/chat/mcp-egress.ts`): the same CONNECT-tunnel design,
 * the same fail-closed discipline, duplicated per process the way this repo
 * duplicates every queue adapter rather than importing across apps. Two
 * shapes are exposed over one tunnel core:
 *
 *   - `createEgressMcpFetch` — the text fetch `createExternalMcpTool`
 *     (connect-runtime) requires; without it the runtime refuses every call.
 *   - `createEgressBinaryFetch` — a byte fetch for the finished MP4. The
 *     provider's result URL is never fetched directly: it goes through the
 *     same proxy, over verified TLS, with a size cap sized for video.
 *
 * Fail closed, no fallback:
 *   - no or malformed proxy URL      -> every call throws (never a direct fetch)
 *   - target not https               -> throws before any socket is opened
 *   - proxy unreachable or refusing  -> throws
 *   - TLS not verifiable             -> throws (rejectUnauthorized is always on)
 *   - redirects                      -> never followed
 *   - response over the size cap     -> throws
 *   - overall timeout                -> throws
 *
 * The proxy URL may carry credentials (user:pass); they are only ever sent
 * as a Proxy-Authorization header to the proxy and are never logged.
 */
import http from 'node:http';
import tls from 'node:tls';
import { isIP, type Socket } from 'node:net';
import type { ExternalMcpFetch, ExternalMcpFetchResponse } from '@tugpt/connect-runtime';

export const EGRESS_PROXY_ENV = 'CONNECT_EGRESS_PROXY';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_BINARY_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BINARY_BYTES = 256 * 1024 * 1024;

export type EgressErrorCode =
  | 'EGRESS_NOT_CONFIGURED' | 'EGRESS_HTTPS_ONLY' | 'EGRESS_REFUSED' | 'EGRESS_UNREACHABLE'
  | 'EGRESS_TIMEOUT' | 'EGRESS_RESPONSE_TOO_LARGE' | 'EGRESS_TLS' | 'EGRESS_BAD_STATUS';

export class EgressError extends Error {
  constructor(readonly code: EgressErrorCode) {
    super(code);
    this.name = 'EgressError';
  }
}

/** Only a plain http:// CONNECT proxy given as host + port is accepted. */
export function parseEgressProxy(raw: string | undefined): URL | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== 'http:' || !url.hostname) return null;
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) return null;
  return url;
}

export interface EgressFetchOptions {
  readonly proxyUrl: string | undefined;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Extra trust anchors (tests use a throwaway CA). Otherwise the system store is used. */
  readonly ca?: string | Buffer;
}

function proxyAuthHeader(proxy: URL): Record<string, string> {
  if (!proxy.username) return {};
  const user = decodeURIComponent(proxy.username);
  const pass = decodeURIComponent(proxy.password);
  return { 'proxy-authorization': `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
}

function openTunnel(proxy: URL, host: string, port: number, deadline: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const authority = `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
    const req = http.request({
      host: proxy.hostname.replace(/^\[|\]$/g, ''),
      port: proxy.port ? Number(proxy.port) : 80,
      method: 'CONNECT',
      path: authority,
      headers: { host: authority, ...proxyAuthHeader(proxy) },
      agent: false,
      signal: deadline,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new EgressError('EGRESS_REFUSED'));
        return;
      }
      resolve(socket);
    });
    req.once('error', () => reject(new EgressError(deadline.aborted ? 'EGRESS_TIMEOUT' : 'EGRESS_UNREACHABLE')));
    req.end();
  });
}

function startTls(raw: Socket, host: string, ca: string | Buffer | undefined, deadline: AbortSignal): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({
      socket: raw,
      ...(isIP(host) ? {} : { servername: host }),
      ...(ca ? { ca } : {}),
      rejectUnauthorized: true,
      ALPNProtocols: ['http/1.1'],
    });
    const onAbort = () => s.destroy();
    deadline.addEventListener('abort', onAbort, { once: true });
    s.once('secureConnect', () => resolve(s));
    s.once('error', () => { raw.destroy(); reject(new EgressError(deadline.aborted ? 'EGRESS_TIMEOUT' : 'EGRESS_TLS')); });
  });
}

interface TunnelResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  chunks: Buffer[];
}

/** One HTTPS request through the tunnel, collecting the body up to `maxBytes`. */
async function tunnelRequest(
  proxy: URL,
  rawUrl: string,
  init: { method: string; headers: Record<string, string>; body?: Buffer },
  options: { timeoutMs: number; maxBytes: number; ca?: string | Buffer },
): Promise<TunnelResponse> {
  let target: URL;
  try { target = new URL(rawUrl); } catch { throw new EgressError('EGRESS_HTTPS_ONLY'); }
  if (target.protocol !== 'https:' || target.username || target.password) throw new EgressError('EGRESS_HTTPS_ONLY');
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const port = target.port ? Number(target.port) : 443;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const raw = await openTunnel(proxy, host, port, controller.signal);
    const secure = await startTls(raw, host, options.ca, controller.signal);
    return await new Promise<TunnelResponse>((resolve, reject) => {
      const body = init.body ?? Buffer.alloc(0);
      const req = http.request({
        createConnection: () => secure,
        method: init.method,
        path: `${target.pathname}${target.search}`,
        headers: {
          ...init.headers, host: target.host, 'content-length': String(body.length), connection: 'close',
        },
        signal: controller.signal,
      });
      req.once('response', (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > options.maxBytes) { res.destroy(); req.destroy(); reject(new EgressError('EGRESS_RESPONSE_TOO_LARGE')); return; }
          chunks.push(c);
        });
        res.once('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, chunks });
        });
        res.once('error', () => reject(new EgressError(controller.signal.aborted ? 'EGRESS_TIMEOUT' : 'EGRESS_UNREACHABLE')));
      });
      req.once('error', () => reject(new EgressError(controller.signal.aborted ? 'EGRESS_TIMEOUT' : 'EGRESS_UNREACHABLE')));
      req.end(body);
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An `ExternalMcpFetch` that can only reach the network through the egress
 * proxy. With no valid proxy configured it returns a fetch that always throws.
 */
export function createEgressMcpFetch(options: EgressFetchOptions): ExternalMcpFetch {
  const proxy = parseEgressProxy(options.proxyUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return async (rawUrl, init): Promise<ExternalMcpFetchResponse> => {
    if (!proxy) throw new EgressError('EGRESS_NOT_CONFIGURED');
    const res = await tunnelRequest(
      proxy, rawUrl,
      { method: init.method, headers: { ...init.headers }, body: Buffer.from(init.body, 'utf8') },
      { timeoutMs, maxBytes, ...(options.ca ? { ca: options.ca } : {}) },
    );
    const text = Buffer.concat(res.chunks).toString('utf8');
    const headers = res.headers;
    return {
      status: res.status,
      text: async () => text,
      headers: {
        get: (name: string) => {
          const v = headers[name.toLowerCase()];
          return Array.isArray(v) ? v.join(', ') : (v ?? null);
        },
      },
    };
  };
}

export interface EgressBinaryFetchOptions {
  readonly proxyUrl: string | undefined;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly ca?: string | Buffer;
}

/**
 * A byte fetch for the finished media, through the same tunnel. Only a 200
 * response is a download; anything else (including a redirect, which is
 * never followed) is a typed failure.
 */
export function createEgressBinaryFetch(
  options: EgressBinaryFetchOptions,
): (url: string) => Promise<{ bytes: Uint8Array; contentType: string }> {
  const proxy = parseEgressProxy(options.proxyUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_BINARY_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_BINARY_BYTES;

  return async (url: string) => {
    if (!proxy) throw new EgressError('EGRESS_NOT_CONFIGURED');
    const res = await tunnelRequest(
      proxy, url,
      { method: 'GET', headers: { accept: 'video/mp4, application/octet-stream' } },
      { timeoutMs, maxBytes, ...(options.ca ? { ca: options.ca } : {}) },
    );
    if (res.status !== 200) throw new EgressError('EGRESS_BAD_STATUS');
    const contentType = res.headers['content-type'];
    return {
      bytes: new Uint8Array(Buffer.concat(res.chunks)),
      contentType: typeof contentType === 'string' ? contentType : 'video/mp4',
    };
  };
}
