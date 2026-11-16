/**
 * Test-only harness for the customer MCP chat path. Not imported by app code.
 *
 * REAL (actual sockets on 127.0.0.1, actual TLS, actual JSON-RPC):
 *   - startMcpServer: an HTTPS MCP server (Streamable HTTP, JSON or SSE replies)
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

export interface RpcCall { readonly method: string; readonly params: unknown; readonly sessionId: string | null; readonly authorization: string | null }
export type ToolReply = { text: string; isError?: boolean } | { rpcError: string };
export type ServerMode = 'ok' | 'http500' | 'redirect' | 'sse' | 'huge';

export interface McpServer {
  readonly port: number;
  readonly calls: RpcCall[];
  mode: ServerMode;
  onTool: (name: string, args: Record<string, unknown>) => ToolReply;
  toolCalls(): RpcCall[];
  close(): Promise<void>;
}

export async function startMcpServer(tlsMaterial: { key: string; cert: string }): Promise<McpServer> {
  const calls: RpcCall[] = [];
  const state = {
    mode: 'ok' as ServerMode,
    onTool: ((name: string, args: Record<string, unknown>) => ({ text: `${name}:${JSON.stringify(args)}` })) as McpServer['onTool'],
  };
  const server = https.createServer(tlsMaterial, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let msg: { id?: number; method?: string; params?: unknown };
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
      const method = String(msg.method);
      calls.push({ method, params: msg.params, sessionId: (req.headers['mcp-session-id'] as string) ?? null, authorization: req.headers.authorization ?? null });
      if (state.mode === 'http500') { res.writeHead(500).end('boom'); return; }
      if (state.mode === 'redirect') { res.writeHead(302, { location: 'https://169.254.169.254/latest/meta-data/' }).end(); return; }
      if (method === 'notifications/initialized') { res.writeHead(202).end(); return; }
      let body: unknown;
      if (method === 'initialize') {
        body = { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' }, sessionId: 'sess-1' } };
      } else if (method === 'tools/call') {
        const p = msg.params as { name: string; arguments: Record<string, unknown> };
        const reply = state.onTool(p.name, p.arguments ?? {});
        body = 'rpcError' in reply
          ? { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: reply.rpcError } }
          : { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: state.mode === 'huge' ? 'x'.repeat(2 * 1024 * 1024) : reply.text }], isError: reply.isError === true } };
      } else {
        body = { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } };
      }
      if (state.mode === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    calls,
    get mode() { return state.mode; },
    set mode(m) { state.mode = m; },
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
export interface Approval { id: string; organization_id: string; connection_id: string; capability: string; arguments_sha256: string; expires_at: number; used_at: number | null; revoked_at: number | null }

export interface FakeState {
  members: Record<string, Record<string, 'owner' | 'admin' | 'manager' | 'member'>>; // org -> user -> role
  endpoints: Row[];
  snapshots: Row[];
  tools: Row[];
  approvals: Approval[];
  catalogue: string[];
  rpcLog: { fn: string; args: Row }[];
  now: () => number;
}

export function emptyState(): FakeState {
  return { members: {}, endpoints: [], snapshots: [], tools: [], approvals: [], catalogue: ['calendar.find_availability'], rpcLog: [], now: () => Date.now() };
}

const RLS_ADMIN_ONLY = new Set(['external_tool_endpoints', 'external_tool_snapshots', 'external_tools']);

class Query implements DbQuery {
  private filters: [string, unknown][] = [];
  private sort: [string, boolean] | null = null;
  private max: number | null = null;
  constructor(private readonly rows: () => Row[], private readonly cols: string) {}
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
  single(): PromiseLike<DbResult> { const r = this.run(); return Promise.resolve(r.length === 1 ? { data: r[0], error: null } : { data: null, error: { code: 'PGRST116' } }); }
  maybeSingle(): PromiseLike<DbResult> { const r = this.run(); return Promise.resolve(r.length <= 1 ? { data: r[0] ?? null, error: null } : { data: null, error: { code: 'PGRST116' } }); }
  then<A = DbResult, B = never>(ok?: ((v: DbResult) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve({ data: this.run(), error: null } as DbResult).then(ok, bad);
  }
}

/** A user-scoped client: what auth.uid() = userId may see and do. */
export function fakeDb(state: FakeState, userId: string): ChatDb & { failTables: Set<string> } {
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
        : new Query(() => table(name), cols));
      return { select: make, insert: () => make(''), update: () => make('') };
    },
    async rpc(fn: string, args: Row): Promise<DbResult> {
      state.rpcLog.push({ fn, args });
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
          && x.arguments_sha256 === args.p_arguments_sha256 && x.expires_at > now && x.used_at === null && x.revoked_at === null)[0];
        if (!a) return { data: false, error: null };
        a.used_at = now;
        return { data: true, error: null };
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
