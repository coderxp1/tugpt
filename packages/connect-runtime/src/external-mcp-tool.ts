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
import { checkArgumentsAgainstSchema } from './json-schema-args.js';

const MODEL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export interface ExternalMcpFetchResponse {
  readonly status: number;
  text(): Promise<string>;
  /** Response headers (lower-case lookup). Used for the MCP `Mcp-Session-Id` header. */
  readonly headers?: { get(name: string): string | null };
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

export interface ExternalMcpToolListEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
}

export type McpDiscoveryErrorCode =
  | 'DISCOVERY_HTTP_STATUS'   // non-2xx reply (incl. 3xx: redirects are never followed)
  | 'DISCOVERY_MALFORMED'     // not JSON / not JSON-RPC 2.0 / wrong id / missing result / bad tools shape
  | 'DISCOVERY_RPC_ERROR'     // JSON-RPC error object
  | 'DISCOVERY_INVALID_TOOL'  // a tool violates the snapshot contract (mirrors the DB CHECKs)
  | 'DISCOVERY_TOO_LARGE';    // more tools/pages than a snapshot may hold

/** Discovery failed; nothing from this discovery may be persisted. */
export class McpDiscoveryError extends Error {
  constructor(readonly code: McpDiscoveryErrorCode, message: string) {
    super(message);
    this.name = 'McpDiscoveryError';
  }
}

/** Mirrors public.external_tools CHECKs, so invalid input fails here, before any DB write. */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_SNAPSHOT_TOOLS = 256;
const MAX_TOOL_PAGES = 10;
/** Largest MCP reply body this adapter parses, independent of the transport's own cap (egress: 1 MiB). */
export const MAX_MCP_REPLY_BYTES = 1024 * 1024;
/** Largest tools/call text result handed on; bigger results are OUTPUT_TOO_LARGE, never truncated. */
export const MAX_MCP_RESULT_TEXT_BYTES = 64 * 1024;
/** MCP protocol revisions this client implements. The negotiated one is sent as MCP-Protocol-Version. */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26'];
const CLIENT_PROTOCOL_VERSION = '2025-06-18';

/** A reply exceeded MAX_MCP_REPLY_BYTES (discovery: DISCOVERY_TOO_LARGE; tools/call: OUTPUT_TOO_LARGE). */
class McpTooLargeError extends McpDiscoveryError {
  constructor() { super('DISCOVERY_TOO_LARGE', 'MCP reply too large'); }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The JSON-RPC messages in a reply body. Streamable HTTP answers either with one JSON message or with an
 * SSE stream; an SSE event's data is the concatenation of its `data:` lines joined by "\n" (events are
 * separated by a blank line), and a stream may carry server notifications/requests before the response.
 */
function replyMessages(text: string, contentType: string | null): string[] {
  const looksSse = (contentType ?? '').toLowerCase().startsWith('text/event-stream') || /^(event|data|id|retry):/m.test(text.trimStart().slice(0, 64));
  if (!looksSse) return [text];
  const out: string[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
    if (data.length > 0) out.push(data.join('\n'));
  }
  return out;
}

/**
 * Parse one JSON-RPC reply and return the `result` of the response to `id`. Strict: the response must be
 * JSON-RPC 2.0 with exactly this id; a JSON-RPC error object is an error; no response at all is an error.
 */
function parseRpcReply(text: string, id: number, contentType: string | null = null): Record<string, unknown> {
  if (Buffer.byteLength(text, 'utf8') > MAX_MCP_REPLY_BYTES) throw new McpTooLargeError();
  for (const c of replyMessages(text, contentType)) {
    let msg: unknown;
    try { msg = JSON.parse(c); } catch { continue; }
    if (!isRecord(msg) || !('id' in msg) || msg.id !== id) continue; // notifications, other responses
    // A server->client REQUEST (it has a method) may reuse our id: ids are per sender. It is not our response.
    if ('method' in msg) continue;
    if (msg.jsonrpc !== '2.0') throw new McpDiscoveryError('DISCOVERY_MALFORMED', 'reply is not JSON-RPC 2.0');
    if ('error' in msg && msg.error !== undefined) throw new McpDiscoveryError('DISCOVERY_RPC_ERROR', 'MCP endpoint returned a JSON-RPC error');
    if (!isRecord(msg.result)) throw new McpDiscoveryError('DISCOVERY_MALFORMED', 'JSON-RPC reply has no result object');
    return msg.result;
  }
  throw new McpDiscoveryError('DISCOVERY_MALFORMED', 'no JSON-RPC reply for the request');
}

/**
 * One MCP Streamable HTTP session (spec 2025-06-18): initialize, then the `notifications/initialized`
 * notification, then requests.
 *
 * Session contract: the session id is ONLY the `Mcp-Session-Id` RESPONSE HEADER of the initialize reply.
 * When present it is sent on every later message; when absent the server is stateless and no header is
 * sent. Nothing in the initialize result body is ever used as a session id - that is not part of the
 * protocol, and trusting it would let a reply body choose a header value.
 * The notification carries no `id` and must be answered 2xx (202 per spec); anything else aborts.
 * Only 200 is accepted for requests; redirects are never followed.
 * Version: the initialize result's `protocolVersion` must be one this client implements, otherwise the
 * session is abandoned before any other message; the negotiated version is sent as the
 * `MCP-Protocol-Version` header on every later message (spec 2025-06-18, transports).
 */
const SESSION_ID_PATTERN = /^[\x21-\x7e]{1,256}$/; // visible ASCII, per spec

async function openMcpSession(endpoint: ExternalMcpEndpoint, fetchFn: ExternalMcpFetch) {
  // Set once, after initialize; read by send() for every later message.
  const protocol: { negotiated?: string } = {};
  async function send(message: Record<string, unknown>, sessionId: string | undefined) {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (endpoint.authHeader) headers.authorization = endpoint.authHeader;
    if (sessionId !== undefined) headers['mcp-session-id'] = sessionId;
    if (protocol.negotiated !== undefined) headers['mcp-protocol-version'] = protocol.negotiated;
    return fetchFn(endpoint.url, { method: 'POST', headers, redirect: 'manual', body: JSON.stringify({ jsonrpc: '2.0', ...message }) });
  }
  async function request(id: number, method: string, params: unknown, sessionId: string | undefined) {
    const res = await send({ id, method, params }, sessionId);
    if (res.status !== 200) throw new McpDiscoveryError('DISCOVERY_HTTP_STATUS', `MCP endpoint returned HTTP ${res.status}`);
    return { result: parseRpcReply(await res.text(), id, res.headers?.get('content-type') ?? null), headers: res.headers };
  }

  const init = await request(1, 'initialize', {
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'tugpt', version: '1.0.0' },
  }, undefined);
  const header = init.headers?.get('mcp-session-id') ?? null;
  if (header !== null && !SESSION_ID_PATTERN.test(header)) {
    throw new McpDiscoveryError('DISCOVERY_MALFORMED', 'Mcp-Session-Id header is not visible ASCII');
  }
  const sessionId = header ?? undefined;
  const version = init.result.protocolVersion;
  if (typeof version !== 'string' || !SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(version)) {
    throw new McpDiscoveryError('DISCOVERY_MALFORMED', 'MCP endpoint negotiated an unsupported protocol version');
  }
  protocol.negotiated = version;

  const ack = await send({ method: 'notifications/initialized' }, sessionId);
  if (ack.status < 200 || ack.status > 299) {
    throw new McpDiscoveryError('DISCOVERY_HTTP_STATUS', `MCP endpoint returned HTTP ${ack.status} to initialized`);
  }

  let nextId = 2;
  return {
    sessionId,
    protocolVersion: version,
    call: (method: string, params: unknown) => request(nextId++, method, params, sessionId).then((r) => r.result),
  };
}

function validateTool(raw: unknown): ExternalMcpToolListEntry {
  if (!isRecord(raw)) throw new McpDiscoveryError('DISCOVERY_INVALID_TOOL', 'tool entry is not an object');
  const { name, description, inputSchema } = raw;
  if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) {
    throw new McpDiscoveryError('DISCOVERY_INVALID_TOOL', 'tool name is missing or invalid');
  }
  if (description !== undefined && (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LENGTH)) {
    throw new McpDiscoveryError('DISCOVERY_INVALID_TOOL', `tool ${name}: description is invalid`);
  }
  if (!isRecord(inputSchema) || inputSchema.type !== 'object') {
    throw new McpDiscoveryError('DISCOVERY_INVALID_TOOL', `tool ${name}: inputSchema must be a JSON Schema object`);
  }
  return { name, description: typeof description === 'string' ? description : '', inputSchema: inputSchema as JsonSchemaObject };
}

/**
 * Fetch an endpoint's tool list (initialize + tools/list, following
 * pagination) for the approval snapshot. Read-only: never calls a tool.
 *
 * `fetchFn` is REQUIRED and is the only transport used: there is no fallback
 * (not `endpoint.fetchFn`, not a global fetch). Callers pass the egress-proxy
 * fetch. All-or-nothing: any invalid page or tool throws McpDiscoveryError,
 * so a partial tool list is never returned.
 */
export async function listExternalMcpTools(
  endpoint: ExternalMcpEndpoint,
  fetchFn: ExternalMcpFetch,
): Promise<ExternalMcpToolListEntry[]> {
  if (typeof fetchFn !== 'function') throw new Error('egress proxy required for customer MCP (B-8)');
  await assertPublicEndpoint(endpoint.url, endpoint.resolveHostname);

  const session = await openMcpSession(endpoint, fetchFn);

  const tools: ExternalMcpToolListEntry[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= MAX_TOOL_PAGES) throw new McpDiscoveryError('DISCOVERY_TOO_LARGE', 'too many tools/list pages');
    const result = await session.call('tools/list', cursor ? { cursor } : {});
    if (!Array.isArray(result.tools)) throw new McpDiscoveryError('DISCOVERY_MALFORMED', 'tools/list result has no tools array');
    for (const raw of result.tools) {
      const tool = validateTool(raw);
      if (seen.has(tool.name)) throw new McpDiscoveryError('DISCOVERY_INVALID_TOOL', `duplicate tool name ${tool.name}`);
      seen.add(tool.name);
      tools.push(tool);
      if (tools.length > MAX_SNAPSHOT_TOOLS) throw new McpDiscoveryError('DISCOVERY_TOO_LARGE', 'too many tools for one snapshot');
    }
    const next = result.nextCursor;
    if (next === undefined || next === null || next === '') break;
    if (typeof next !== 'string') throw new McpDiscoveryError('DISCOVERY_MALFORMED', 'nextCursor is not a string');
    cursor = next;
  }
  return tools;
}

function normalizeModelName(name: string): string {
  const candidate = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return MODEL_NAME_PATTERN.test(candidate) ? candidate : `mcp_${candidate}`;
}

/**
 * A ConnectTool that runs one approved external MCP tool.
 *
 * `endpoint.fetchFn` is REQUIRED - callers pass the egress-proxy fetch. There is no default transport and
 * no deferred failure: constructing the tool without one throws, so a mis-wired caller fails at
 * registry build time instead of every call silently reporting PROVIDER_UNAVAILABLE.
 *
 * Every execute opens a fresh session (initialize -> notifications/initialized -> tools/call) and maps
 * every failure - SSRF floor, transport, non-200, notification not 2xx, malformed or mismatched reply,
 * unsupported protocol version, JSON-RPC error, malformed result - to PROVIDER_UNAVAILABLE. A well-formed
 * result with `isError: true` is TOOL_ERROR (the tool itself refused); its text is never returned.
 * A reply body over MAX_MCP_REPLY_BYTES or a text result over MAX_MCP_RESULT_TEXT_BYTES is
 * OUTPUT_TOO_LARGE (never truncated; the runtime applies its own, smaller cap to what reaches the model).
 * A reply body is never returned unless it is a well-formed result for this exact call.
 */
export function createExternalMcpTool(
  endpoint: ExternalMcpEndpoint,
  toolDef: ExternalMcpToolDef,
): ConnectTool<Record<string, unknown>> {
  const fetchFn = endpoint.fetchFn;
  if (typeof fetchFn !== 'function') throw new TypeError('egress proxy required for customer MCP (B-8): endpoint.fetchFn is missing');

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
      // Checked against the APPROVED snapshot's schema before the runtime claims any approval.
      const checked = checkArgumentsAgainstSchema(toolDef.inputSchema, raw);
      if (!checked.ok) return { ok: false, detail: checked.detail };
      return { ok: true, value: raw as Record<string, unknown> };
    },
    async execute(args): Promise<ToolOutput> {
      const unavailable = { ok: false, code: 'PROVIDER_UNAVAILABLE' as ToolErrorCode } as const;
      const tooLarge = { ok: false, code: 'OUTPUT_TOO_LARGE' as ToolErrorCode } as const;
      try {
        await assertPublicEndpoint(endpoint.url, endpoint.resolveHostname);
        const session = await openMcpSession(endpoint, fetchFn);
        const result = await session.call('tools/call', { name: toolDef.name, arguments: args });
        // The server ran the tool and the tool refused or failed: the endpoint is reachable, so this is not
        // PROVIDER_UNAVAILABLE. The error text is untrusted and is never returned.
        if (result.isError === true) return { ok: false, code: 'TOOL_ERROR' };
        if (result.content !== undefined && !Array.isArray(result.content)) return unavailable;
        const text = ((result.content ?? []) as unknown[])
          .filter((c): c is { type: 'text'; text: string } => isRecord(c) && c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('\n');
        if (Buffer.byteLength(text, 'utf8') > MAX_MCP_RESULT_TEXT_BYTES) return tooLarge;
        return { ok: true, data: { content: text } };
      } catch (e) {
        return e instanceof McpTooLargeError ? tooLarge : unavailable;
      }
    },
  };
}
