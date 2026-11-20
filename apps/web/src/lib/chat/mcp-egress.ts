/**
 * Proxy-only transport for customer MCP calls from chat (B-8 / B-9).
 *
 * `createExternalMcpTool` (connect-runtime) never touches the network itself:
 * without an injected fetch it refuses every call. This module is that fetch.
 * It can only reach a customer endpoint through the egress proxy named in
 * CONNECT_EGRESS_PROXY, using an HTTP CONNECT tunnel:
 *
 *   web -> CONNECT host:443 -> egress proxy (resolves once, checks the address,
 *   connects) -> TLS to the customer endpoint, verified end to end here.
 *
 * Fail closed, no fallback:
 *   - no or malformed proxy URL      -> every call throws (never a direct fetch)
 *   - target not https               -> throws before any socket is opened
 *   - proxy unreachable or refusing  -> throws (non-200 CONNECT reply)
 *   - TLS not verifiable             -> throws (rejectUnauthorized is always on)
 *   - redirects                      -> never followed; the status is returned
 *   - response over the size cap     -> throws
 *   - overall timeout                -> throws
 *
 * The proxy URL may carry credentials (user:pass); they are only ever sent as
 * a Proxy-Authorization header to the proxy and are never logged or returned.
 */
import http from 'node:http';
import tls from 'node:tls';
import { isIP, type Socket } from 'node:net';
import type { ExternalMcpFetch, ExternalMcpFetchResponse } from '@tugpt/connect-runtime';

export const EGRESS_PROXY_ENV = 'CONNECT_EGRESS_PROXY';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export type EgressErrorCode =
  | 'EGRESS_NOT_CONFIGURED' | 'EGRESS_HTTPS_ONLY' | 'EGRESS_REFUSED' | 'EGRESS_UNREACHABLE'
  | 'EGRESS_TIMEOUT' | 'EGRESS_RESPONSE_TOO_LARGE' | 'EGRESS_TLS';

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
    let target: URL;
    try { target = new URL(rawUrl); } catch { throw new EgressError('EGRESS_HTTPS_ONLY'); }
    if (target.protocol !== 'https:' || target.username || target.password) throw new EgressError('EGRESS_HTTPS_ONLY');
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const port = target.port ? Number(target.port) : 443;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const raw = await openTunnel(proxy, host, port, controller.signal);
      const secure = await startTls(raw, host, options.ca, controller.signal);
      return await new Promise<ExternalMcpFetchResponse>((resolve, reject) => {
        const body = Buffer.from(init.body, 'utf8');
        const req = http.request({
          createConnection: () => secure,
          method: init.method,
          path: `${target.pathname}${target.search}`,
          headers: { ...init.headers, host: target.host, 'content-length': String(body.length), connection: 'close' },
          signal: controller.signal,
        });
        req.once('response', (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > maxBytes) { res.destroy(); req.destroy(); reject(new EgressError('EGRESS_RESPONSE_TOO_LARGE')); return; }
            chunks.push(c);
          });
          res.once('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            // Redirects are returned as-is and never followed (init.redirect is ignored on purpose).
            const headers = res.headers;
            resolve({
              status: res.statusCode ?? 0,
              text: async () => text,
              headers: { get: (name: string) => {
                const v = headers[name.toLowerCase()];
                return Array.isArray(v) ? v.join(', ') : (v ?? null);
              } },
            });
          });
          res.once('error', () => reject(new EgressError(controller.signal.aborted ? 'EGRESS_TIMEOUT' : 'EGRESS_UNREACHABLE')));
        });
        req.once('error', () => reject(new EgressError(controller.signal.aborted ? 'EGRESS_TIMEOUT' : 'EGRESS_UNREACHABLE')));
        req.end(body);
      });
    } finally {
      clearTimeout(timer);
    }
  };
}
