/**
 * Test-only harness for the customer MCP chat path. Not imported by app code.
 *
 * REAL (actual sockets on 127.0.0.1, actual TLS, actual JSON-RPC):
 *   - startMcpServer: an HTTPS MCP server (Streamable HTTP, JSON or SSE replies) that follows the
 *     spec's session contract: the session id exists ONLY in the `Mcp-Session-Id` header of the
 *     initialize response; later requests without it get 400, with an unknown one 404; the
 *     `notifications/initialized` message must carry no id. (Before M5 this double put a
 *     `sessionId` in the initialize RESULT BODY, which no real server does, and accepted requests
 *     without a session - which is how a client that never sent the header passed.)
 *   - startConnectProxy: an HTTP CONNECT egress-proxy double with an allowlist
 *     that maps the requested authority to a local port, the way the real
 *     proxy resolves once and connects to the address it checked
 *   - makeCertificate: a throwaway self-signed certificate from openssl, made
 *     at test time so no key material is committed
 * FAKE (in memory):
 *   - FakeDb: the subset of PostgREST the chat code and Agent 2's functions
 *     use, with the SQL semantics that matter here reproduced from the
 *     migrations: owner/admin-only RLS on external_tool_*,
 *     list_chat_capabilities (SECURITY DEFINER, members see MCP rows),
 *     claim_tool_approval (membership, match, expiry, single use, revoke),
 *     record_connect_tool_call (rejects capabilities outside the catalogue).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ChatDb, DbQuery, DbResult } from './store';

export const MCP_HOST = 'mcp.test.example';

export function opensslAvailable(): boolean {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

export function makeCertificate(host = MCP_HOST): { key: string; cert: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tugpt-mcp-cert-'));
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${host}`,
      '-addext', `subjectAltName=DNS:${host}`, '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'),
    ], { stdio: 'ignore' });
    return { key: readFileSync(path.join(dir, 'k.pem'), 'utf8'), cert: readFileSync(path.join(dir, 'c.pem'), 'utf8') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export interface RpcCall {
  readonly method: string;
  readonly params: unknown;
  /** The request's `id` member; `undefined` when absent (a JSON-RPC notification). */
  readonly id: unknown;
  readonly hasId: boolean;
  readonly sessionId: string | null;
  readonly authorization: string | null;
  /** The MCP-Protocol-Version request header, or null. */
  readonly protocolVersion: string | null;
  /** HTTP status this server answered with. */
  status?: number;
}
export type ToolReply = { text: string; isError?: boolean } | { rpcError: string };
/**
 * ok        JSON replies
 * sse       Streamable HTTP SSE replies, preceded by an unrelated server notification event and with the
 *           response's JSON split over two `data:` lines (both legal per the SSE and MCP specs)
 * http500 / redirect / huge   failure modes
 * notify500 the `notifications/initialized` POST is answered 500
 * wrongId   tools/call replies carry a different id
 * noJsonrpc tools/call replies lack `jsonrpc: "2.0"`
 * badVersion initialize negotiates protocolVersion 1999-01-01, which no client supports.
 * collide    tools/call answers with an SSE stream whose FIRST event is a server->client request
 *            (roots/list) carrying the same id as the client's request, then the real response.
 */
export type ServerMode = 'ok' | 'http500' | 'redirect' | 'sse' | 'huge' | 'notify500' | 'wrongId' | 'noJsonrpc' | 'badVersion' | 'collide';
/**
 * MCP Streamable HTTP session management (spec 2025-06-18, "Session Management"):
 * stateful   the server assigns a session ONLY in the `Mcp-Session-Id` response header of initialize,
 *            answers later requests without it 400 and with an unknown one 404. The initialize result
 *            body carries no session id - that field is not part of the protocol.
 * stateless  the server assigns no session and accepts requests without the header.
 */
export type SessionMode = 'stateful' | 'stateless';

export interface McpServer {
  readonly port: number;
  readonly calls: RpcCall[];
  mode: ServerMode;
  sessionMode: SessionMode;
  /** Session ids this server has issued, in order. */
  readonly sessions: string[];
  onTool: (name: string, args: Record<string, unknown>) => ToolReply;
  toolCalls(): RpcCall[];
  close(): Promise<void>;
}

export async function startMcpServer(tlsMaterial: { key: string; cert: string }): Promise<McpServer> {
  const calls: RpcCall[] = [];
  const sessions: string[] = [];
  const state = {
    mode: 'ok' as ServerMode,
    sessionMode: 'stateful' as SessionMode,
    onTool: ((name: string, args: Record<string, unknown>) => ({ text: `${name}:${JSON.stringify(args)}` })) as McpServer['onTool'],
  };
  const server = https.createServer(tlsMaterial, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let msg: { id?: unknown; method?: string; params?: unknown; jsonrpc?: unknown };
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
      const method = String(msg.method);
      const sessionHeader = (req.headers['mcp-session-id'] as string | undefined) ?? null;
      const call: RpcCall = { method, params: msg.params, id: msg.id, hasId: 'id' in msg, sessionId: sessionHeader, authorization: req.headers.authorization ?? null,
        protocolVersion: (req.headers['mcp-protocol-version'] as string | undefined) ?? null };
      calls.push(call);
      const end = (status: number, headers: Record<string, string> = {}, body?: string) => { call.status = status; res.writeHead(status, headers).end(body); };
      if (state.mode === 'http500') { end(500, {}, 'boom'); return; }
      if (state.mode === 'redirect') { end(302, { location: 'https://169.254.169.254/latest/meta-data/' }); return; }
      if (msg.jsonrpc !== '2.0') { end(400); return; }

      const responseHeaders: Record<string, string> = {};
      if (method === 'initialize') {
        if (state.sessionMode === 'stateful') {
          const sid = `sess-${randomUUID()}`;
          sessions.push(sid);
          responseHeaders['mcp-session-id'] = sid;
        }
      } else if (state.sessionMode === 'stateful') {
        if (!sessionHeader) { end(400, {}, 'missing Mcp-Session-Id'); return; }
        if (!sessions.includes(sessionHeader)) { end(404, {}, 'unknown session'); return; }
      }

      if (method === 'notifications/initialized') {
        // A notification has no id. A message with an id is a request, which this method is not.
        if ('id' in msg) { end(400, {}, 'notifications carry no id'); return; }
        end(state.mode === 'notify500' ? 500 : 202);
        return;
      }
      let body: Record<string, unknown>;
      if (method === 'initialize') {
        body = { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: state.mode === 'badVersion' ? '1999-01-01' : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } } };
      } else if (method === 'tools/list') {
        body = { jsonrpc: '2.0', id: msg.id, result: { tools: [
          { name: 'search_docs', description: 'Search the documentation', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
          { name: 'create_ticket', description: 'Open a ticket', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
        ] } };
      } else if (method === 'tools/call') {
        const p = msg.params as { name: string; arguments: Record<string, unknown> };
        const reply = state.onTool(p.name, p.arguments ?? {});
        body = 'rpcError' in reply
          ? { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: reply.rpcError } }
          : { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: state.mode === 'huge' ? 'x'.repeat(2 * 1024 * 1024) : reply.text }], isError: reply.isError === true } };
        if (state.mode === 'wrongId') body.id = 999;
        if (state.mode === 'noJsonrpc') delete body.jsonrpc;
      } else {
        body = { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } };
      }
      if (state.mode === 'collide' && method === 'tools/call') {
        const serverRequest = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, method: 'roots/list' })}\n\n`;
        end(200, { ...responseHeaders, 'content-type': 'text/event-stream' }, `${serverRequest}event: message\ndata: ${JSON.stringify(body)}\n\n`);
        return;
      }
      if (state.mode === 'sse') {
        const json = JSON.stringify(body, null, 1).split('\n');
        const half = Math.ceil(json.length / 2);
        const preamble = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'working' } })}\n\n`;
        const event = `event: message\nid: 1\ndata: ${json.slice(0, half).join(' ')}\ndata: ${json.slice(half).join(' ')}\n\n`;
        end(200, { ...responseHeaders, 'content-type': 'text/event-stream' }, preamble + event);
      } else {
        end(200, { ...responseHeaders, 'content-type': 'application/json' }, JSON.stringify(body));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    calls,
    sessions,
    get mode() { return state.mode; },
    set mode(m) { state.mode = m; },
    get sessionMode() { return state.sessionMode; },
    set sessionMode(m) { state.sessionMode = m; },
    get onTool() { return state.onTool; },
    set onTool(f) { state.onTool = f; },
    toolCalls: () => calls.filter((c) => c.method === 'tools/call'),
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

export interface ConnectProxy {
  readonly url: string;
  readonly connects: string[];
  refuse: boolean;
  close(): Promise<void>;
}

/** CONNECT-only proxy double. Only allowlisted authorities are tunnelled; plain requests get 405. */
export async function startConnectProxy(allow: Record<string, number>): Promise<ConnectProxy> {
  const connects: string[] = [];
  const state = { refuse: false };
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_req, res) => { res.writeHead(405).end(); });
  server.on('connect', (req, client: net.Socket) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    const authority = String(req.url);
    connects.push(authority);
    const port = allow[authority];
    if (state.refuse || port === undefined) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const upstream = net.connect(port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    connects,
    get refuse() { return state.refuse; },
    set refuse(v) { state.refuse = v; },
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** A port with nothing listening (proxy down). */
export async function deadPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

// ---------------------------------------------------------------- fake database

type Row = Record<string, unknown>;
export interface Approval { id: string; organization_id: string; connection_id: string; capability: string; arguments_sha256: string; expires_at: number; used_at: number | null; revoked_at: number | null; requested_by?: string | null; thread_id?: string | null }

export interface FakeState {
  members: Record<string, Record<string, 'owner' | 'admin' | 'manager' | 'member'>>; // org -> user -> role
  endpoints: Row[];
  snapshots: Row[];
  tools: Row[];
  approvals: Approval[];
  catalogue: string[];
  rpcLog: { fn: string; args: Row }[];
  /** Rows written by record_mcp_tool_call (20261115000006_mcp_audit.sql). */
  mcpAudit: Row[];
  now: () => number;
}

export function emptyState(): FakeState {
  return { members: {}, endpoints: [], snapshots: [], tools: [], approvals: [], catalogue: ['calendar.find_availability'], rpcLog: [], mcpAudit: [], now: () => Date.now() };
}

const RLS_ADMIN_ONLY = new Set(['external_tool_endpoints', 'external_tool_snapshots', 'external_tools']);
/**
 * Column grants of the `authenticated` role, mirroring the real database
 * (20261115000012_mcp_security.sql: table SELECT revoked, safe columns
 * granted; url and auth_connection_id are hidden from members). Reading or
 * filtering on any other column through the user client is a 42501 error,
 * as in Postgres. Found by the M5 real-PostgREST chat run.
 */
export const AUTHENTICATED_COLUMN_GRANTS: Readonly<Record<string, ReadonlySet<string>>> = {
  external_tool_endpoints: new Set(['id', 'organization_id', 'kind', 'display_name', 'status', 'created_by', 'created_at']),
};

class Query implements DbQuery {
  private filters: [string, unknown][] = [];
  private sort: [string, boolean] | null = null;
  private max: number | null = null;
  constructor(private readonly rows: () => Row[], private readonly cols: string, private readonly granted?: ReadonlySet<string>) {}
  /** Postgres needs SELECT on every selected AND filtered column; '*' needs table-level SELECT. */
  private denied(): DbResult | null {
    if (!this.granted) return null;
    const granted = this.granted;
    const used = [...this.cols.split(',').map((c) => c.trim()).filter(Boolean), ...this.filters.map(([k]) => k), ...(this.sort ? [this.sort[0]] : [])];
    return used.some((c) => c === '*' || !granted.has(c)) ? { data: null, error: { code: '42501', message: 'permission denied for table' } } : null;
  }
  select(): DbQuery { return this; }
  eq(column: string, value: unknown): DbQuery { this.filters.push([column, value]); return this; }
  is(column: string, value: null): DbQuery { this.filters.push([column, value]); return this; }
  // PostgREST defaults to ascending; Agent 2's code calls .order('name') without options.
  order(column: string, options?: { ascending: boolean }): DbQuery { this.sort = [column, options?.ascending ?? true]; return this; }
  limit(n: number): DbQuery { this.max = n; return this; }
  private run(): Row[] {
    let out = this.rows().filter((r) => this.filters.every(([k, v]) => r[k] === v));
    if (this.sort) {
      const [k, asc] = this.sort;
      out = [...out].sort((a, b) => (a[k] === b[k] ? 0 : (a[k] as never) < (b[k] as never) ? (asc ? -1 : 1) : (asc ? 1 : -1)));
    }
    if (this.max !== null) out = out.slice(0, this.max);
    const keys = this.cols.split(',').map((c) => c.trim()).filter(Boolean);
    return out.map((r) => Object.fromEntries(keys.map((k) => [k, r[k] ?? null])));
  }
  single(): PromiseLike<DbResult> { const d = this.denied(); if (d) return Promise.resolve(d); const r = this.run(); return Promise.resolve(r.length === 1 ? { data: r[0], error: null } : { data: null, error: { code: 'PGRST116' } }); }
  maybeSingle(): PromiseLike<DbResult> { const d = this.denied(); if (d) return Promise.resolve(d); const r = this.run(); return Promise.resolve(r.length <= 1 ? { data: r[0] ?? null, error: null } : { data: null, error: { code: 'PGRST116' } }); }
  then<A = DbResult, B = never>(ok?: ((v: DbResult) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve(this.denied() ?? ({ data: this.run(), error: null } as DbResult)).then(ok, bad);
  }
}

/** A user-scoped client: what auth.uid() = userId may see and do. */
/**
 * EXECUTE grants as in the real database (proacl after 20261120000001):
 * resolve_mcp_execution and record_mcp_tool_call are callable only by the
 * trusted identity sso_control (platform superuser roles aside); the member
 * (authenticated) client gets 42501. sso_control has no table grants on the
 * external_tool_* tables and no EXECUTE on the member RPCs.
 */
const TRUSTED_ONLY_RPCS = new Set(['resolve_mcp_execution', 'record_mcp_tool_call']);
export type FakeIdentity = 'member' | 'sso_control';

/** The server-side sso_control client (createSsoControlClient in production). */
export function fakeTrustedDb(state: FakeState): ChatDb & { failTables: Set<string> } {
  return fakeDb(state, '', 'sso_control');
}

export function fakeDb(state: FakeState, userId: string, identity: FakeIdentity = 'member'): ChatDb & { failTables: Set<string> } {
  const role = (org: unknown) => state.members[String(org)]?.[userId];
  const isMember = (org: unknown) => role(org) !== undefined;
  const isAdmin = (org: unknown) => role(org) === 'owner' || role(org) === 'admin';
  const table = (name: string): Row[] => {
    const rows = name === 'external_tool_endpoints' ? state.endpoints : name === 'external_tool_snapshots' ? state.snapshots : name === 'external_tools' ? state.tools : [];
    return RLS_ADMIN_ONLY.has(name) ? rows.filter((r) => isAdmin(r.organization_id)) : rows;
  };
  const failTables = new Set<string>();
  return {
    failTables,
    from(name: string) {
      const make = (cols: string): DbQuery => (failTables.has(name)
        ? Object.assign(new Query(() => [], cols), { then: (ok: (v: DbResult) => unknown) => Promise.resolve({ data: null, error: { message: 'down' } }).then(ok) }) as unknown as DbQuery
        : identity === 'sso_control' && name.startsWith('external_tool')
          ? new Query(() => [], cols, new Set<string>())
          : new Query(() => table(name), cols, AUTHENTICATED_COLUMN_GRANTS[name]));
      return { select: make, insert: () => make(''), update: () => make('') };
    },
    async rpc(fn: string, args: Row): Promise<DbResult> {
      state.rpcLog.push({ fn, args });
      if ((identity === 'member') === TRUSTED_ONLY_RPCS.has(fn)) return { data: null, error: { code: '42501', message: 'permission denied for function' } };
      const org = args.p_organization_id;
      if (fn === 'list_chat_capabilities') {
        if (!isMember(org)) return { data: [], error: null };
        const rows = state.tools.filter((t) => t.organization_id === org).flatMap((t) => {
          const s = state.snapshots.find((x) => x.id === t.snapshot_id);
          const e = s && state.endpoints.find((x) => x.id === s.endpoint_id);
          if (!s || !e || e.status !== 'active' || s.approved_at == null || s.revoked_at != null) return [];
          return [{ capability_key: `external.${String(t.name)}`, provider_key: 'mcp', provider_name: e.display_name, description: t.description, permission_class: t.permission_class, state: 'connected', connection_id: e.id }];
        });
        return { data: rows, error: null };
      }
      if (fn === 'claim_tool_approval') {
        if (!isMember(org)) return { data: false, error: null };
        const now = state.now();
        const a = state.approvals.filter((x) => x.organization_id === org && x.connection_id === args.p_connection_id && x.capability === args.p_capability
          && x.arguments_sha256 === args.p_arguments_sha256 && x.expires_at > now && x.used_at === null && x.revoked_at === null
          && x.requested_by === userId && x.thread_id === args.p_thread_id)[0];
        if (!a) return { data: false, error: null };
        a.used_at = now;
        return { data: true, error: null };
      }
      if (fn === 'is_tool_approved') {
        if (!isMember(org)) return { data: false, error: null };
        const now = state.now();
        return { data: state.approvals.some((x) => x.organization_id === org && x.connection_id === args.p_connection_id && x.capability === args.p_capability
          && x.arguments_sha256 === args.p_arguments_sha256 && x.expires_at > now && x.used_at === null && x.revoked_at === null
          && x.requested_by === userId && x.thread_id === args.p_thread_id), error: null };
      }
      if (fn === 'list_mcp_capabilities') {
        if (!isMember(org)) return { data: [], error: null };
        const out = [];
        for (const e of state.endpoints.filter((x) => x.organization_id === org && x.status === 'active')) {
          const snaps = state.snapshots.filter((s) => s.endpoint_id === e.id && s.organization_id === org).sort((a, b) => Number(b.version) - Number(a.version));
          const newest = snaps[0];
          if (!newest || newest.approved_at == null || newest.revoked_at != null) continue;
          for (const t of state.tools.filter((x) => x.snapshot_id === newest.id && x.organization_id === org)) {
            out.push({ endpointId: e.id, name: t.name, description: t.description, inputSchema: t.input_schema, permissionClass: t.permission_class });
          }
        }
        return { data: out, error: null };
      }
      if (fn === 'resolve_mcp_execution') {
        // Mirrors 20261120000003: the trusted path also requires no stored credential (auth_connection_id IS NULL).
        const e = state.endpoints.find((x) => x.id === args.p_endpoint_id && x.organization_id === org && x.status === 'active' && x.auth_connection_id == null);
        if (!e) return { data: null, error: null }; // the SQL function returns NULL (no row), not an error
        const snaps = state.snapshots.filter((s) => s.endpoint_id === e.id && s.organization_id === org).sort((a, b) => Number(b.version) - Number(a.version));
        const newest = snaps[0];
        if (!newest || newest.approved_at == null || newest.revoked_at != null) return { data: null, error: null };
        const tools = state.tools.filter((t) => t.snapshot_id === newest.id && t.organization_id === org).map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema, permissionClass: t.permission_class }));
        return { data: { endpointId: e.id, url: e.url, tools }, error: null };
      }
            if (fn === 'record_mcp_tool_call') {
        // Mirrors 20261115000013+ (trusted caller supplies the actor): the ACTOR must be a member of the organization.
        if (state.members[String(org)]?.[String(args.p_actor_user_id)] === undefined) return { data: null, error: { code: '42501', message: 'FORBIDDEN' } };
        state.mcpAudit.push({ ...args, actor: args.p_actor_user_id });
        return { data: null, error: null };
      }
      if (fn === 'record_connect_tool_call') {
        // Mirrors 20261115000001: capability_key REFERENCES integration_capabilities(key).
        if (!state.catalogue.includes(String(args.p_capability_key))) return { data: null, error: { code: '23503', message: 'fk' } };
        return { data: null, error: null };
      }
      return { data: null, error: { message: `unknown rpc ${fn}` } };
    },
  };
}

export function approve(state: FakeState, a: Omit<Approval, 'id' | 'used_at' | 'revoked_at'>): Approval {
  const row: Approval = { ...a, id: `ap-${state.approvals.length + 1}`, used_at: null, revoked_at: null };
  state.approvals.push(row);
  return row;
}
