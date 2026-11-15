/**
 * Customer-facing MCP tool adapter.
 *
 * Turns an APPROVED external MCP tool (from `external_tools`, after an admin
 * classified its permission) into a `ConnectTool` the runtime can execute.
 * The endpoint URL and its resolved auth header are supplied by the caller â€”
 * this module never holds credentials and never names the internal admin
 * bridge. It speaks the MCP Streamable HTTP transport over the global fetch.
 *
 * SSRF boundary: `assertPublicEndpoint` is the code-level floor â€” HTTPS
 * enforcement plus DNS resolution that rejects loopback, private, link-local,
 * metadata, CGNAT, ULA and multicast addresses. It is defense-in-depth, NOT
 * the whole boundary: staging/production MUST route customer MCP egress
 * through an allowlisting CONNECT proxy that resolves once and connects to
 * the address it checked (docs/connect/broker-egress.md). A DNS-rebinding
 * window remains in this in-process check because `fetch` re-resolves; only
 * the proxy closes it.
 */

import { promises as dnsPromises } from 'node:dns';
import type { JsonSchemaObject } from '@tugpt/ai-providers';
import type { ConnectTool, ToolErrorCode, ToolOutput, ValidationOutcome } from './types.js';

const MODEL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export interface ExternalMcpFetchResponse {
  readonly status: number;
  text(): Promise<string>;
}
export interface ExternalMcpFetch {
  (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: 'manual' | 'error' | 'follow' }): Promise<ExternalMcpFetchResponse>;
}
export type HostnameResolver = (hostname: string) => Promise<string[]>;

export interface ExternalMcpEndpoint {
  /** HTTPS MCP endpoint. */
  readonly url: string;
  /** Resolved authorization header for this connection (e.g. `Bearer â€¦`). */
  readonly authHeader?: string;
  readonly fetchFn?: ExternalMcpFetch;
  /** Injectable for tests; defaults to the system DNS resolver. */
  readonly resolveHostname?: HostnameResolver;
}

export interface ExternalMcpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  readonly permissionClass: 'read' | 'write' | 'irreversible' | 'financial';
}

function parseIPv4(ip: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = [m[1], m[2], m[3], m[4]].map(Number);
  if (parts.some((p) => p < 0 || p > 255)) return null;
  return parts as [number, number, number, number];
}

function isPrivateIPv4(o: [number, number, number, number]): boolean {
  const [a, b, c, d] = o;
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // 10.0.0.0/8 private
    a === 127 || // 127.0.0.0/8 loopback
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local + metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF
    (a === 192 && b === 0 && c === 2) || // 192.0.2.0/24 TEST-NET
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmark
    (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // 203.0.113.0/24 TEST-NET-3
    a >= 224 || // multicast + reserved
    (a === 255 && b === 255 && c === 255 && d === 255) // broadcast
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped: ::ffff:a.b.c.d
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const v4 = parseIPv4(mapped[1]);
    return v4 === null || isPrivateIPv4(v4);
  }
  if (lower === '::' || lower === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
  if (/^ff[0-9a-f]{2}:/.test(lower)) return true; // ff00::/8 multicast
  if (/^2001:db8:/.test(lower)) return true; // 2001:db8::/32 documentation
  return false;
}

function isPrivateIp(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return isPrivateIPv4(v4);
  return isPrivateIPv6(ip);
}

export async function defaultResolveHostname(hostname: string): Promise<string[]> {
  const ips: string[] = [];
  try {
    ips.push(...(await dnsPromises.resolve4(hostname)));
  } catch {
    // no A records
  }
  try {
    ips.push(...(await dnsPromises.resolve6(hostname)));
  } catch {
    // no AAAA records
  }
  return ips;
}

/** Reject non-HTTPS endpoints (static floor; the egress proxy does the IP check). */
export function assertHttpsEndpoint(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('invalid MCP endpoint URL');
  }
  const isHttps = url.protocol === 'https:';
  const isLoopback =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if (!isHttps && !isLoopback) {
    throw new Error('MCP endpoint must be https (or http on loopback for development)');
  }
  return url.toString();
}

/**
 * The full in-process SSRF floor: HTTPS enforcement plus a DNS check that
 * rejects loopback/private/link-local/metadata/reserved addresses.
 */
export async function assertPublicEndpoint(
  rawUrl: string,
  resolve: HostnameResolver = defaultResolveHostname,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('invalid MCP endpoint URL');
  }
  const isHttps = url.protocol === 'https:';
  const isLoopbackDev =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if (!isHttps && !isLoopbackDev) {
    throw new Error('MCP endpoint must be https (or http on loopback for development)');
  }

  const hostname = url.hostname;
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.lan')
  ) {
    throw new Error('MCP endpoint must not target an internal host');
  }

  if (hostname.includes(':')) {
    // IPv6 literal.
    if (isPrivateIPv6(hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error('MCP endpoint must not target a private address');
    }
    return url.toString();
  }

  const v4 = parseIPv4(hostname);
  if (v4) {
    if (isPrivateIPv4(v4)) throw new Error('MCP endpoint must not target a private address');
    return url.toString();
  }

  const ips = await resolve(hostname);
  if (ips.length === 0) throw new Error('MCP endpoint host does not resolve');
  if (ips.some((ip) => isPrivateIp(ip))) {
    throw new Error('MCP endpoint must not target a private address');
  }
  return url.toString();
}

function defaultFetch(): ExternalMcpFetch {
  // Fail closed: customer MCP must never reach the network directly. The caller
  // must inject a proxy-aware fetch that routes through CONNECT_EGRESS_PROXY
  // (redirect: 'manual' so a 3xx cannot bypass address validation).
  return async () => {
    throw new Error('egress proxy required for customer MCP (B-8)');
  };
}

export interface ExternalMcpToolListEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
}

/**
 * Fetch an endpoint's tool list (initialize + tools/list) for the approval
 * snapshot. Read-only: never calls a tool.
 */
export async function listExternalMcpTools(
  endpoint: ExternalMcpEndpoint,
  fetchFn?: ExternalMcpFetch,
): Promise<ExternalMcpToolListEntry[]> {
  await assertPublicEndpoint(endpoint.url, endpoint.resolveHostname);
  const fn = fetchFn ?? endpoint.fetchFn ?? defaultFetch();

  async function rpc(id: number, method: string, params: unknown, sessionId?: string): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (endpoint.authHeader) headers.authorization = endpoint.authHeader;
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const res = await fn(endpoint.url, { method: 'POST', headers, redirect: 'manual', body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    if (res.status !== 200) throw new Error(`MCP endpoint returned HTTP ${res.status}`);
    const text = await res.text();
    const dataLine = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    return JSON.parse(dataLine || text) as Record<string, unknown>;
  }

  const init = (await rpc(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'tugpt', version: '1.0.0' },
  })) as { result?: { sessionId?: string } };
  const sessionId = init.result?.sessionId;
  await rpc(2, 'notifications/initialized', undefined, sessionId).catch(() => undefined);
  const list = (await rpc(3, 'tools/list', {}, sessionId)) as {
    result?: { tools?: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }> };
  };
  const tools = list.result?.tools ?? [];
  return tools.map((t) => ({
    name: typeof t.name === 'string' ? t.name : '',
    description: typeof t.description === 'string' ? t.description : '',
    inputSchema: (t.inputSchema as JsonSchemaObject) ?? { type: 'object' },
  }));
}

function normalizeModelName(name: string): string {
  const candidate = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return MODEL_NAME_PATTERN.test(candidate) ? candidate : `mcp_${candidate}`;
}

export function createExternalMcpTool(
  endpoint: ExternalMcpEndpoint,
  toolDef: ExternalMcpToolDef,
): ConnectTool<Record<string, unknown>> {
  const fetchFn: ExternalMcpFetch =
    endpoint.fetchFn ??
    (async () => {
      throw new Error('egress proxy required for customer MCP (B-8)');
    });

  async function rpc(id: number, method: string, params: unknown, sessionId?: string): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (endpoint.authHeader) headers.authorization = endpoint.authHeader;
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const res = await fetchFn(endpoint.url, {
      method: 'POST',
      headers,
      redirect: 'manual',
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (res.status !== 200) throw new Error(`MCP endpoint returned HTTP ${res.status}`);
    const text = await res.text();
    const dataLine = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    return JSON.parse(dataLine || text) as unknown;
  }

  const capability = `external.${toolDef.name}`;
  const modelName = normalizeModelName(toolDef.name);
  const risk: 'read' | 'write' = toolDef.permissionClass === 'read' ? 'read' : 'write';

  return {
    capability,
    modelName,
    provider: 'mcp',
    risk,
    acceptedScopes: [],
    description: toolDef.description,
    parameters: toolDef.inputSchema,
    validate(raw): ValidationOutcome<Record<string, unknown>> {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, detail: 'arguments must be a JSON object' };
      }
      return { ok: true, value: raw as Record<string, unknown> };
    },
    async execute(args): Promise<ToolOutput> {
      try {
        await assertPublicEndpoint(endpoint.url, endpoint.resolveHostname);
        const init = (await rpc(1, 'initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'tugpt', version: '1.0.0' },
        })) as { result?: { sessionId?: string } };
        const sessionId = init.result?.sessionId;
        await rpc(2, 'notifications/initialized', undefined, sessionId).catch(() => undefined);
        const call = (await rpc(3, 'tools/call', { name: toolDef.name, arguments: args }, sessionId)) as {
          result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
          error?: unknown;
        };
        if (call.error || call.result?.isError) return { ok: false, code: 'PROVIDER_UNAVAILABLE' as ToolErrorCode };
        const text = (call.result?.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('\n');
        return { ok: true, data: { content: text } };
      } catch {
        return { ok: false, code: 'PROVIDER_UNAVAILABLE' as ToolErrorCode };
      }
    },
  };
}
