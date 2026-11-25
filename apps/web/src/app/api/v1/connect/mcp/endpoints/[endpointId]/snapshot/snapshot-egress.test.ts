/**
 * Snapshot route egress + versioning (Agent 2 M4).
 *
 * REAL: the route handler, createEgressMcpFetch (HTTP CONNECT + TLS), the
 * runtime discovery client, a local CONNECT proxy and a local HTTPS MCP
 * server (throwaway CA), all over real sockets on 127.0.0.1.
 * MOCKED (labelled): session/tenant (AuthService), the repository (in-memory,
 * except getEndpointUrl, which is the REAL repository method over a stand-in rpc client returning
 * PostgREST error shapes, so F-M9-1 is tested through the real error mapping;
 * mirroring create_mcp_snapshot_idempotent / get_mcp_snapshot_request: one snapshot per Idempotency-Key,
 * version = max + 1 assigned by the store; the real RPCs are covered by pgTAP mcp_snapshot_idempotency and
 * by the real Next -> PostgREST -> Postgres script scripts/regression/snapshot-idempotency.py), the customer
 * MCP flag (on here; it stays off by default), the trust anchor (test CA
 * injected into the real egress fetch) and the runtime's defence-in-depth
 * DNS pre-check (the test hostname resolves to a fixed public address).
 *
 * The test proxy maps the test hostname to the local server: it stands in for
 * the production proxy's routing only. It proves the web tier reaches the
 * network ONLY via CONNECT <hostname>; it does NOT prove the production
 * proxy's DNS pinning or private-range policy (see docs/connect/agent2-handover.md).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

const ORIGIN = 'https://app.test';
const ORG = 'a4000000-0000-4000-8000-00000000000a';
const EP = 'a4000000-0000-4000-8000-0000000e0001';
const HOST = 'mcp.customer.test';
const T = vi.hoisted(() => ({ ca: '' as string, timeoutMs: 3000, injectCa: true, dnsCalls: 0 }));

// ---- in-memory repository (MOCKED; mirrors create_mcp_snapshot_idempotent's contract) ----
type Snap = { id: string; version: number; sha: string; tools: { name: string }[] };
type CreateFail = null | 'busy' | 'endpoint-busy' | 'deadline' | 'timeout' | 'in-progress' | 'not-found';
const db = vi.hoisted(() => ({ snaps: [] as Snap[], writes: 0, latestReads: 0, createCalls: 0,
  requests: new Map<string, string>(), running: new Set<string>(), lastDeadline: '' as string,
  createFails: null as CreateFail, latestTimeout: false, failLatest: false,
  endpointError: null as null | { code: string; message: string }, endpointLookups: 0,
  auth: null as null | { connectionId: string; kind: string; status: string },
  secretResult: { ok: false, code: 'UNAVAILABLE' } as { ok: boolean; code?: string; value?: { secret: string; credentialVersion: number } },
  tokenResult: { ok: false, code: 'UNAVAILABLE' } as { ok: boolean; code?: string; value?: { accessToken: string; expiresAt: string; credentialVersion: number } } }));
vi.mock('@/lib/connect/external-mcp-repo', async (orig) => {
  const real = await orig<typeof import('@/lib/connect/external-mcp-repo')>();
  return {
    ...real,
    createExternalMcpRepository: () => ({
      // REAL getEndpointUrl over a stand-in rpc (labelled): db.endpointError is what PostgREST returned.
      getEndpointUrl: (org: string, id: string) => real.createExternalMcpRepository({
        rpc: async (_fn: string, a: { p_organization_id: string; p_endpoint_id: string }) => {
          db.endpointLookups++;
          if (db.endpointError) return { data: null, error: db.endpointError };
          return { data: a.p_organization_id === ORG && a.p_endpoint_id === EP ? `https://${HOST}/mcp` : null, error: null };
        },
      } as never).getEndpointUrl(org, id),
      // Status lookup (latestReads counts every database read the route makes before discovery).
      getSnapshotRequest: async (_o: string, _e: string, key: string) => {
        db.latestReads++;
        if (db.latestTimeout) throw new real.DatabaseTimeoutError();
        if (db.failLatest) throw new Error('read failed');
        if (db.running.has(key)) return { state: 'in_progress' as const };
        const id = db.requests.get(key);
        const snap = db.snaps.find((x) => x.id === id);
        return snap ? { state: 'committed' as const, snapshotId: snap.id, version: snap.version, toolCount: snap.tools.length } : { state: 'not_found' as const };
      },
      getEndpointAuth: async () => db.auth,
      createSnapshotIdempotent: async (_o: string, _e: string, key: string, sha: string, tools: { name: string }[], deadline: string) => {
        db.createCalls++; db.lastDeadline = deadline;
        switch (db.createFails) {
          case 'busy': throw new real.SnapshotStoreBusyError();
          case 'endpoint-busy': throw new real.SnapshotEndpointBusyError();
          case 'deadline': throw new real.SnapshotDeadlineExceededError();
          case 'timeout': throw new real.DatabaseTimeoutError();
          case 'in-progress': throw new real.SnapshotRequestInProgressError();
          case 'not-found': throw new real.SnapshotEndpointNotFoundError();
        }
        const prior = db.snaps.find((x) => x.id === db.requests.get(key));
        if (prior) return { snapshotId: prior.id, version: prior.version, toolCount: prior.tools.length, replayed: true };
        db.writes++;
        const version = db.snaps.reduce((m, x) => Math.max(m, x.version), 0) + 1;
        const id = `snap-${version}`;
        db.snaps.push({ id, version, sha, tools: tools.map((t) => ({ name: t.name })) });
        db.requests.set(key, id);
        return { snapshotId: id, version, toolCount: tools.length, replayed: false };
      },
    }),
  };
});
vi.mock('@/lib/supabase/server', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/server')>()),
  createAuthenticatedServerClient: async () => ({}),
}));
vi.mock('@tugpt/auth', async (orig) => ({
  ...(await orig<typeof import('@tugpt/auth')>()),
  AuthService: class {
    async getCurrentUser() { return { id: 'u-owner' }; }
    async resolveTenantContext() { return { organizationId: ORG, organizationName: 'Org', role: 'owner' }; }
  },
}));
vi.mock('@/lib/connect-ui/flags.server', () => ({ customerMcpEnabled: () => true }));
// Broker credential sources (labelled): the route must resolve the endpoint's
// credential through these and never fall back to unauthenticated discovery.
vi.mock('@/lib/chat/connect', async (orig) => {
  const real = await orig<typeof import('@/lib/chat/connect')>();
  return { ...real,
    brokerStaticSecretSource: () => ({ getStaticSecret: async () => db.secretResult }),
    brokerTokenSource: () => ({ getAccessToken: async () => db.tokenResult }),
  };
});
// Real egress fetch; only the trust anchor and the timeout are injected.
vi.mock('@/lib/chat/mcp-egress', async (orig) => {
  const real = await orig<typeof import('@/lib/chat/mcp-egress')>();
  return { ...real, createEgressMcpFetch: (o: Parameters<typeof real.createEgressMcpFetch>[0]) =>
    real.createEgressMcpFetch({ ...o, ...(T.injectCa ? { ca: T.ca } : {}), timeoutMs: T.timeoutMs }) };
});
// Real discovery client; only the defence-in-depth DNS pre-check is pinned.
vi.mock('@tugpt/connect-runtime', async (orig) => {
  const real = await orig<typeof import('@tugpt/connect-runtime')>();
  return { ...real, listExternalMcpTools: (ep: { url: string }, f: Parameters<typeof real.listExternalMcpTools>[1]) =>
    real.listExternalMcpTools({ ...ep, resolveHostname: async () => { T.dnsCalls++; return ['93.184.216.34']; } }, f) };
});

const { POST, GET } = await import('./route');

// ---- real sockets: HTTPS MCP server + CONNECT proxy ----
type Mode = 'ok' | 'malformed' | 'rpc-error' | 'hang' | 'redirect' | 'page2-500' | 'page2-invalid' | 'v2-tools';
let mode: Mode = 'ok';
let mcp: https.Server; let mcpPort = 0; let mcpConnections = 0; let mcpRequests = 0;
let lastAuthorization: string | null = null;
let proxy: http.Server; let proxyPort = 0; let proxyMode: 'allow' | 'refuse' = 'allow';
const connects: string[] = []; let tunnels = 0;
let deadPort = 0;
const sockets = new Set<Duplex>();
const track = (sk: Duplex) => { sockets.add(sk); sk.once('close', () => sockets.delete(sk)); };
let redirectTargetHits = 0; let redirectTarget: http.Server; let redirectPort = 0;

function mcpReply(body: { id?: number; method: string; params?: { cursor?: string } }, res: http.ServerResponse) {
  const send = (o: unknown, status = 200, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(o));
  };
  const tool = (name: string) => ({ name, description: `d ${name}`, inputSchema: { type: 'object' } });
  if (body.method === 'initialize') {
    if (mode === 'malformed') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>not json</html>'); return; }
    if (mode === 'hang') return; // never answers
    if (mode === 'redirect') { send({}, 302, { location: `http://127.0.0.1:${redirectPort}/steal` }); return; }
    send({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }, 200, { 'mcp-session-id': 's-1' }); return;
  }
  if (body.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
  if (body.method === 'tools/list') {
    if (mode === 'rpc-error') { send({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'nope' } }); return; }
    if (mode.startsWith('page2') && body.params?.cursor === 'c2') {
      if (mode === 'page2-500') { send({}, 500); return; }
      send({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'bad name!' }] } }); return;
    }
    if (mode.startsWith('page2')) { send({ jsonrpc: '2.0', id: body.id, result: { tools: [tool('p1')], nextCursor: 'c2' } }); return; }
    send({ jsonrpc: '2.0', id: body.id, result: { tools: mode === 'v2-tools' ? [tool('search'), tool('create'), tool('delete')] : [tool('search'), tool('create')] } });
    return;
  }
  send({}, 404);
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2-m4-'));
  const o = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  o(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=a2-m4-test-ca']);
  o(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', `/CN=${HOST}`]);
  writeFileSync(join(dir, 'ext.cnf'), `subjectAltName=DNS:${HOST}\n`);
  o(['x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.pem', '-days', '1', '-extfile', 'ext.cnf']);
  T.ca = readFileSync(join(dir, 'ca.pem'), 'utf8');

  mcp = https.createServer({ key: readFileSync(join(dir, 'srv.key')), cert: readFileSync(join(dir, 'srv.pem')) }, (req, res) => {
    mcpRequests++;
    lastAuthorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : null;
    let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => mcpReply(JSON.parse(raw || '{}'), res));
  });
  mcp.on('connection', (sk) => { mcpConnections++; track(sk); });
  await new Promise<void>((r) => mcp.listen(0, '127.0.0.1', r));
  mcpPort = (mcp.address() as AddressInfo).port;

  redirectTarget = http.createServer((_q, s) => { redirectTargetHits++; s.end('stolen'); });
  await new Promise<void>((r) => redirectTarget.listen(0, '127.0.0.1', r));
  redirectPort = (redirectTarget.address() as AddressInfo).port;

  proxy = http.createServer((_q, s) => { s.writeHead(405); s.end(); });
  proxy.on('connection', track);
  proxy.on('connect', (req, client) => {
    connects.push(req.url ?? '');
    track(client);
    if (proxyMode === 'refuse' || req.url !== `${HOST}:443`) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const up = net.connect(mcpPort, '127.0.0.1');
    track(up);
    up.once('connect', () => { tunnels++; client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(client); client.pipe(up); });
    up.on('error', () => client.destroy()); client.on('error', () => up.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  proxyPort = (proxy.address() as AddressInfo).port;

  const tmp = net.createServer(); await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
  deadPort = (tmp.address() as AddressInfo).port; await new Promise((r) => tmp.close(r));
});
afterAll(async () => {
  for (const sk of sockets) sk.destroy();
  for (const s of [mcp, proxy, redirectTarget]) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); }
});
afterEach(() => { for (const sk of sockets) sk.destroy(); });

let globalFetch: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubEnv('TUGPT_APP_ORIGIN', ORIGIN);
  vi.stubEnv('CONNECT_EGRESS_PROXY', `http://127.0.0.1:${proxyPort}`);
  Object.assign(db, { snaps: [], writes: 0, latestReads: 0, createCalls: 0, failLatest: false, createFails: null, latestTimeout: false,
    endpointError: null, endpointLookups: 0, auth: null,
    secretResult: { ok: false, code: 'UNAVAILABLE' }, tokenResult: { ok: false, code: 'UNAVAILABLE' },
    requests: new Map(), running: new Set(), lastDeadline: '' });
  lastAuthorization = null;
  mode = 'ok'; proxyMode = 'allow'; T.injectCa = true; T.timeoutMs = 3000; T.dnsCalls = 0;
  connects.length = 0; tunnels = 0; mcpConnections = 0; mcpRequests = 0; redirectTargetHits = 0;
  globalFetch = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => { globalFetch.mockRestore(); vi.unstubAllEnvs(); });

let keySeq = 0;
/** A fresh valid Idempotency-Key per call unless one is given (null = send no header). */
function nextKey() { keySeq++; return `test-key-${String(keySeq).padStart(8, '0')}`; }
type SnapBody = { error?: { code: string; message?: string }; version?: number; snapshotId?: string; toolCount?: number; replayed?: boolean };
async function snapshotWithHeaders(key: string | null = nextKey()) {
  const headers: Record<string, string> = { origin: ORIGIN, 'x-tugpt-csrf': '1', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-tenant-id': ORG };
  if (key !== null) headers['idempotency-key'] = key;
  const req = new Request(`${ORIGIN}/api/v1/connect/mcp/endpoints/${EP}/snapshot`, { method: 'POST', body: '{}', headers });
  const res = await POST(req, { params: Promise.resolve({ endpointId: EP }) });
  return { status: res.status, headers: res.headers, body: await res.json() as SnapBody };
}
async function snapshot(key: string | null = nextKey()) {
  const { status, body } = await snapshotWithHeaders(key);
  return { status, body };
}
async function status(key: string | null) {
  const q = key === null ? '' : `?idempotencyKey=${encodeURIComponent(key)}`;
  const req = new Request(`${ORIGIN}/api/v1/connect/mcp/endpoints/${EP}/snapshot${q}`, { headers: { 'x-tenant-id': ORG } });
  const res = await GET(req, { params: Promise.resolve({ endpointId: EP }) });
  return { status: res.status, headers: res.headers, body: await res.json() as Record<string, unknown> };
}
/** Every socket that reached the MCP server came through a proxy tunnel; no global fetch. */
function expectProxyOnly() {
  expect(mcpConnections).toBe(tunnels);
  expect(connects.every((c) => c === `${HOST}:443`)).toBe(true); // hostname, not an IP: DNS is the proxy's job
  expect(globalFetch).not.toHaveBeenCalled();
}

describe('proxy missing or unavailable -> 503 EGRESS_UNAVAILABLE, nothing written, no network', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['https scheme', 'https://127.0.0.1:3128'],
    ['socks scheme', 'socks5://127.0.0.1:1080'],
    ['with a path', 'http://127.0.0.1:3128/x'],
    ['garbage', 'not a url'],
  ])('CONNECT_EGRESS_PROXY %s', async (_n, value) => {
    if (value === undefined) vi.stubEnv('CONNECT_EGRESS_PROXY', undefined as unknown as string); else vi.stubEnv('CONNECT_EGRESS_PROXY', value);
    const r = await snapshot();
    expect(r).toEqual({ status: 503, body: { error: { code: 'EGRESS_UNAVAILABLE', message: 'The egress proxy is not available' } } });
    // M9: the Idempotency-Key status lookup runs first (a committed replay needs no egress); no write is attempted.
    expect([db.writes, db.createCalls, T.dnsCalls, connects.length, mcpConnections]).toEqual([0, 0, 0, 0, 0]);
    expect(globalFetch).not.toHaveBeenCalled();
  });
  it('proxy configured but unreachable (closed port)', async () => {
    vi.stubEnv('CONNECT_EGRESS_PROXY', `http://127.0.0.1:${deadPort}`);
    const r = await snapshot();
    expect(r.status).toBe(503); expect(r.body.error?.code).toBe('EGRESS_UNAVAILABLE');
    expect([db.writes, mcpConnections]).toEqual([0, 0]); expect(globalFetch).not.toHaveBeenCalled();
  });
  it('proxy refuses the destination (403 to CONNECT) -> 502 EGRESS_REFUSED, never connects directly', async () => {
    proxyMode = 'refuse';
    const r = await snapshot();
    expect(r.status).toBe(502); expect(r.body.error?.code).toBe('EGRESS_REFUSED');
    expect(connects).toEqual([`${HOST}:443`]);
    expect([db.writes, mcpConnections]).toEqual([0, 0]); expect(globalFetch).not.toHaveBeenCalled();
  });
});

describe('proxy success: versions are sequential and computed, never hard-coded', () => {
  it('first = v1, second = v2, third = v3, all through the proxy', async () => {
    const a = await snapshot(); mode = 'v2-tools'; const b = await snapshot(); const c = await snapshot();
    expect([a.status, b.status, c.status]).toEqual([201, 201, 201]);
    expect([a.body.version, b.body.version, c.body.version]).toEqual([1, 2, 3]);
    expect([a.body.toolCount, b.body.toolCount, c.body.toolCount]).toEqual([2, 3, 3]);
    expect(db.snaps.map((s) => s.version)).toEqual([1, 2, 3]);
    expect(db.snaps[0].sha).not.toBe(db.snaps[1].sha);
    expect(db.snaps[1].sha).toBe(db.snaps[2].sha); // same tools -> same content hash, new version
    expect(tunnels).toBeGreaterThanOrEqual(9); // >= 3 requests x 3 snapshots, each over its own tunnel
    expectProxyOnly();
  });
  it('a failed status read fails closed (500), nothing discovered or written', async () => {
    db.failLatest = true;
    const r = await snapshot();
    expect(r.status).toBe(500); expect([db.writes, db.createCalls, mcpConnections]).toEqual([0, 0, 0]);
  });
  it('the write carries a deadline of now + 3 s, never a client-chosen version', async () => {
    const t0 = Date.now(); await snapshot(); const t1 = Date.now();
    const d = Date.parse(db.lastDeadline);
    expect(d).toBeGreaterThanOrEqual(t0 + 3000); expect(d).toBeLessThanOrEqual(t1 + 3000);
  });
});

describe('Idempotency-Key (M9)', () => {
  it('a committed key is replayed even while the egress proxy is unavailable', async () => {
    const key = nextKey(); const a = await snapshot(key);
    vi.stubEnv('CONNECT_EGRESS_PROXY', '');
    const b = await snapshot(key);
    expect([a.status, b.status]).toEqual([201, 200]); expect(b.body.snapshotId).toBe(a.body.snapshotId);
  });
  it.each([
    ['missing', null, 'IDEMPOTENCY_KEY_REQUIRED'],
    ['empty', '', 'IDEMPOTENCY_KEY_REQUIRED'],
    ['too short', 'short-key', 'INVALID_IDEMPOTENCY_KEY'],
    ['too long', 'k'.repeat(129), 'INVALID_IDEMPOTENCY_KEY'],
    ['bad characters', 'key with spaces 1234', 'INVALID_IDEMPOTENCY_KEY'],
  ])('%s -> 400 %s before any session, database or network work', async (_n, key, code) => {
    const r = await snapshot(key);
    expect(r.status).toBe(400); expect(r.body.error?.code).toBe(code);
    expect([db.latestReads, db.createCalls, connects.length, mcpConnections]).toEqual([0, 0, 0, 0]);
  });
  it('a cross-origin POST is still refused first (CSRF before the key check)', async () => {
    const req = new Request(`${ORIGIN}/api/v1/connect/mcp/endpoints/${EP}/snapshot`, {
      method: 'POST', body: '{}', headers: { origin: 'https://evil.test', 'content-type': 'application/json', 'idempotency-key': nextKey() },
    });
    const res = await POST(req, { params: Promise.resolve({ endpointId: EP }) });
    expect(res.status).toBe(403); expect([db.latestReads, db.createCalls]).toEqual([0, 0]);
  });
  it('replay of a committed key -> 200 with the ORIGINAL snapshot, no discovery, no second write', async () => {
    const key = nextKey();
    const a = await snapshotWithHeaders(key);
    const tunnelsAfterFirst = tunnels;
    const b = await snapshotWithHeaders(key);
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body).toEqual({ snapshotId: a.body.snapshotId, version: a.body.version, toolCount: a.body.toolCount, replayed: true });
    expect(b.headers.get('idempotent-replayed')).toBe('true'); expect(b.headers.get('idempotency-key')).toBe(key);
    expect(a.headers.get('idempotent-replayed')).toBeNull();
    expect([db.writes, db.snaps.length, tunnels]).toEqual([1, 1, tunnelsAfterFirst]);
  });
  it('a different key creates the next version', async () => {
    const a = await snapshot(); const b = await snapshot();
    expect([a.body.version, b.body.version]).toEqual([1, 2]); expect(db.writes).toBe(2);
  });
  it('same key still running -> 409 IN_PROGRESS with Retry-After, nothing discovered or written', async () => {
    const key = nextKey(); db.running.add(key);
    const r = await snapshotWithHeaders(key);
    expect(r.status).toBe(409); expect(r.body.error?.code).toBe('IN_PROGRESS');
    expect(r.body.error?.message).toMatch(/still running/); expect(r.body.error?.message).not.toMatch(/created concurrently/);
    expect(r.headers.get('retry-after')).toBe('2');
    expect([db.writes, db.createCalls, mcpConnections]).toEqual([0, 0, 0]);
  });
  it('same key started running during discovery (database PT409) -> 409 IN_PROGRESS', async () => {
    db.createFails = 'in-progress';
    const r = await snapshot();
    expect(r.status).toBe(409); expect(r.body.error?.code).toBe('IN_PROGRESS'); expect(db.writes).toBe(0);
  });
  it('after a rolled-back attempt the replay creates exactly one snapshot', async () => {
    const key = nextKey();
    db.createFails = 'deadline'; const a = await snapshot(key);
    db.createFails = null; const b = await snapshot(key); const c = await snapshot(key);
    expect([a.status, b.status, c.status]).toEqual([503, 201, 200]);
    expect(c.body.snapshotId).toBe(b.body.snapshotId); expect(db.snaps).toHaveLength(1);
  });
  it('the endpoint disappeared between the check and the write (P0002) -> 404', async () => {
    db.createFails = 'not-found';
    const r = await snapshot();
    expect(r.status).toBe(404); expect(r.body.error?.code).toBe('NOT_FOUND');
  });
});

describe('GET ?idempotencyKey= status (M9)', () => {
  it('not_found -> committed with the snapshot; in_progress carries Retry-After', async () => {
    const key = nextKey();
    expect((await status(key)).body).toEqual({ state: 'not_found' });
    const a = await snapshot(key);
    const s = await status(key);
    expect(s.status).toBe(200);
    expect(s.body).toEqual({ state: 'committed', snapshotId: a.body.snapshotId, version: a.body.version, toolCount: a.body.toolCount });
    expect(s.headers.get('cache-control')).toBe('no-store');
    const k2 = nextKey(); db.running.add(k2);
    const p = await status(k2);
    expect(p.body).toEqual({ state: 'in_progress' }); expect(p.headers.get('retry-after')).toBe('2');
  });
  it('missing or malformed key -> 400; database timeout -> 503 DATABASE_TIMEOUT', async () => {
    expect((await status(null)).status).toBe(400);
    expect((await status('bad key')).status).toBe(400);
    db.latestTimeout = true;
    const r = await status(nextKey());
    expect(r.status).toBe(503); expect((r.body.error as { code: string }).code).toBe('DATABASE_TIMEOUT');
  });
});

describe('database busy or timed out -> documented 503, never 500, nothing written (M7/M9)', () => {
  it.each([
    ['busy', 'SNAPSHOT_STORE_BUSY', /nothing was saved/],
    ['endpoint-busy', 'ENDPOINT_BUSY', /Another snapshot of this endpoint is being saved; nothing was saved/],
    ['deadline', 'SNAPSHOT_DEADLINE_EXCEEDED', /rolled back; nothing was saved/],
    ['timeout', 'DATABASE_TIMEOUT', /same Idempotency-Key; a retry never creates a duplicate/],
  ] as const)('create %s -> 503 %s with Retry-After and the key echoed', async (fail, code, msg) => {
    const key = nextKey();
    db.createFails = fail;
    const r = await snapshotWithHeaders(key);
    expect(r.status).toBe(503); expect(r.body.error?.code).toBe(code); expect(r.body.error?.message).toMatch(msg);
    expect(r.body.error?.message).toMatch(/Idempotency-Key/);
    expect(r.headers.get('retry-after')).toBe('2'); expect(r.headers.get('idempotency-key')).toBe(key); expect(db.writes).toBe(0);
  });
  it('the app gave up on the status read -> 503 DATABASE_TIMEOUT, no discovery, no create attempted', async () => {
    db.latestTimeout = true;
    const r = await snapshotWithHeaders();
    expect(r.status).toBe(503); expect(r.body.error?.code).toBe('DATABASE_TIMEOUT'); expect([db.writes, db.createCalls, mcpConnections]).toEqual([0, 0, 0]);
  });
  it('the route never reports the old misleading 409 SNAPSHOT_VERSION_CONFLICT', () => {
    expect(readFileSync(join(__dirname, 'route.ts'), 'utf8')).not.toMatch(/SNAPSHOT_VERSION_CONFLICT|created concurrently/);
  });
});

describe('endpoint lookup failures are not "not found" (F-M9-1)', () => {
  const LOOKUP_FAILURES = [
    ['our fetch timed out', { code: '', message: 'TimeoutError: The operation was aborted due to timeout' }],
    ['55P03 lock_not_available (endpoints table locked)', { code: '55P03', message: 'canceling statement due to lock timeout' }],
    ['57014 statement timeout', { code: '57014', message: 'canceling statement due to statement timeout' }],
    ['network failure', { code: '', message: 'TypeError: fetch failed' }],
    ['PostgREST cannot reach the database', { code: 'PGRST000', message: 'Database client error' }],
  ] as const;
  it.each(LOOKUP_FAILURES)('POST: %s -> 503 DATABASE_TIMEOUT with the key echoed; the same key then creates exactly one snapshot', async (_n, error) => {
    const key = nextKey();
    db.endpointError = { ...error };
    const r = await snapshotWithHeaders(key);
    expect(r.status).toBe(503); expect(r.body.error?.code).toBe('DATABASE_TIMEOUT');
    expect(r.headers.get('retry-after')).toBe('2'); expect(r.headers.get('idempotency-key')).toBe(key);
    expect([db.endpointLookups, db.latestReads, db.createCalls, db.writes, mcpConnections]).toEqual([1, 0, 0, 0, 0]);
    db.endpointError = null;
    const ok = await snapshot(key);
    expect(ok.status).toBe(201); expect(db.writes).toBe(1);
    const again = await snapshot(key);
    expect(again.status).toBe(200); expect(again.body.snapshotId).toBe(ok.body.snapshotId); expect(db.writes).toBe(1);
  });
  it.each(LOOKUP_FAILURES)('GET: %s -> 503 DATABASE_TIMEOUT, not 404; then the real state', async (_n, error) => {
    const key = nextKey();
    db.endpointError = { ...error };
    const r = await status(key);
    expect(r.status).toBe(503); expect((r.body.error as { code: string }).code).toBe('DATABASE_TIMEOUT');
    expect(r.headers.get('retry-after')).toBe('2'); expect(r.headers.get('idempotency-key')).toBe(key);
    expect(db.latestReads).toBe(0);
    db.endpointError = null;
    expect((await status(key)).body).toEqual({ state: 'not_found' });
  });
  it('42501 from the lookup -> 403 FORBIDDEN for POST and GET, never 404', async () => {
    db.endpointError = { code: '42501', message: 'FORBIDDEN' };
    const p = await snapshotWithHeaders();
    expect(p.status).toBe(403); expect(p.body.error?.code).toBe('FORBIDDEN');
    const g = await status(nextKey());
    expect(g.status).toBe(403); expect((g.body.error as { code: string }).code).toBe('FORBIDDEN');
    expect([db.createCalls, db.writes, mcpConnections]).toEqual([0, 0, 0]);
  });
  it('a genuinely missing endpoint (RPC answered NULL) is still 404 NOT_FOUND', async () => {
    const other = 'a4000000-0000-4000-8000-0000000e0fff';
    const req = new Request(`${ORIGIN}/api/v1/connect/mcp/endpoints/${other}/snapshot?idempotencyKey=${nextKey()}`, { headers: { 'x-tenant-id': ORG } });
    const res = await GET(req, { params: Promise.resolve({ endpointId: other }) });
    expect(res.status).toBe(404); expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});

describe('discovery failures write nothing (no snapshot, no partial tools)', () => {
  it.each([
    ['malformed (HTML instead of JSON-RPC)', 'malformed', 502, 'DISCOVERY_MALFORMED'],
    ['JSON-RPC error on tools/list', 'rpc-error', 502, 'DISCOVERY_RPC_ERROR'],
    ['partial: page 2 returns HTTP 500', 'page2-500', 502, 'DISCOVERY_HTTP_STATUS'],
    ['partial: page 2 has an invalid tool', 'page2-invalid', 502, 'DISCOVERY_INVALID_TOOL'],
    ['redirect (never followed)', 'redirect', 502, 'DISCOVERY_HTTP_STATUS'],
  ] as const)('%s', async (_n, m, status, codeExpected) => {
    mode = m;
    const r = await snapshot();
    expect(r.status).toBe(status); expect(r.body.error?.code).toBe(codeExpected);
    expect([db.writes, db.createCalls, db.snaps.length]).toEqual([0, 0, 0]);
    expect(redirectTargetHits).toBe(0);
    expectProxyOnly();
  });
  it('timeout (server never answers) -> 504 DISCOVERY_TIMEOUT', async () => {
    mode = 'hang'; T.timeoutMs = 400;
    const r = await snapshot();
    expect(r.status).toBe(504); expect(r.body.error?.code).toBe('DISCOVERY_TIMEOUT');
    expect([db.writes, db.snaps.length]).toEqual([0, 0]); expectProxyOnly();
  });
  it('untrusted TLS certificate -> 502 DISCOVERY_TLS (verification is never disabled)', async () => {
    T.injectCa = false;
    const r = await snapshot();
    expect(r.status).toBe(502); expect(r.body.error?.code).toBe('DISCOVERY_TLS');
    expect([db.writes, mcpRequests]).toEqual([0, 0]); expectProxyOnly();
  });
  it('a failure after earlier successes leaves the existing versions intact', async () => {
    await snapshot(); await snapshot();
    mode = 'page2-500'; const r = await snapshot();
    expect(r.status).toBe(502);
    expect(db.snaps.map((s) => s.version)).toEqual([1, 2]);
    mode = 'ok'; expect((await snapshot()).body.version).toBe(3);
  });
});

describe('structural: no direct network fallback can be reintroduced', () => {
  const route = readFileSync(join(__dirname, 'route.ts'), 'utf8');
  const runtime = readFileSync(join(__dirname, '../../../../../../../../../../../packages/connect-runtime/src/external-mcp-tool.ts'), 'utf8');
  it('route discovers only via createEgressMcpFetch and never calls fetch/http directly', () => {
    expect(route).toMatch(/createEgressMcpFetch\(\{ proxyUrl \}\)/);
    expect(route).toMatch(/listExternalMcpTools\(\{ url: endpoint, \.\.\.\(authHeader \? \{ authHeader \} : \{\}\) \}, egressFetch\)/);
    expect(route).not.toMatch(/(^|[^.\w])fetch\(|globalThis\.fetch|node:https?'|undici|node:net/m);
    expect(route).not.toMatch(/createSnapshot\(/); // M9: the version is assigned by the database, never by the route
    expect(route).toMatch(/createSnapshotIdempotent\(organizationId, endpointId, key, contentSha256, tools, deadline\)/);
  });
  it('runtime discovery has no fallback transport', () => {
    const body = runtime.slice(runtime.indexOf('export async function listExternalMcpTools'), runtime.indexOf('function normalizeModelName'));
    expect(body).toMatch(/fetchFn: ExternalMcpFetch,\n\): /); // required parameter
    expect(body).not.toMatch(/endpoint\.fetchFn|defaultFetch|globalThis\.fetch|[^\w.]fetch\(/);
  });
});

describe('authenticated discovery (A1 static / A2 OAuth): broker-resolved, never downgraded', () => {
  it('a connected static credential is sent as Bearer <redacted> during discovery', async () => {
    db.auth = { connectionId: 'c-static', kind: 'mcp_static_bearer', status: 'connected' };
    db.secretResult = { ok: true, value: { secret: 'static-secret-1', credentialVersion: 3 } };
    const r = await snapshot();
    expect(r.status).toBe(201);
    expect(lastAuthorization).toBe('Bearer static-secret-1');
    expectProxyOnly();
  });

  it('an unresolvable static credential fails 409 CREDENTIAL_UNAVAILABLE before any discovery', async () => {
    db.auth = { connectionId: 'c-static', kind: 'mcp_static_bearer', status: 'connected' };
    db.secretResult = { ok: false, code: 'UNAVAILABLE' };
    const r = await snapshot();
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe('CREDENTIAL_UNAVAILABLE');
    expect(mcpRequests).toBe(0);
    expect(db.writes).toBe(0);
  });

  it('a connected OAuth credential is sent as the broker access token', async () => {
    db.auth = { connectionId: 'c-oauth', kind: 'oauth_token_set', status: 'connected' };
    db.tokenResult = { ok: true, value: { accessToken: 'oauth-token-1', expiresAt: new Date(Date.now() + 3600e3).toISOString(), credentialVersion: 1 } };
    const r = await snapshot();
    expect(r.status).toBe(201);
    expect(lastAuthorization).toBe('Bearer oauth-token-1');
    expectProxyOnly();
  });

  it('an OAuth connection that still requires authorization fails 409 before any discovery or broker read', async () => {
    db.auth = { connectionId: 'c-oauth', kind: 'oauth_token_set', status: 'requires_authorization' };
    db.tokenResult = { ok: true, value: { accessToken: 'must-not-be-used', expiresAt: new Date(Date.now() + 3600e3).toISOString(), credentialVersion: 1 } };
    const r = await snapshot();
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe('CREDENTIAL_UNAVAILABLE');
    expect(mcpRequests).toBe(0);
    expect(db.writes).toBe(0);
  });
});
