/**
 * Snapshot route egress + versioning (Agent 2 M4).
 *
 * REAL: the route handler, createEgressMcpFetch (HTTP CONNECT + TLS), the
 * runtime discovery client, a local CONNECT proxy and a local HTTPS MCP
 * server (throwaway CA), all over real sockets on 127.0.0.1.
 * MOCKED (labelled): session/tenant (AuthService), the repository (in-memory,
 * enforcing the same latest+1 rule as create_mcp_snapshot; the real RPC is
 * covered by the pgTAP test mcp_snapshot_versioning.test.sql), the customer
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

// ---- in-memory repository (MOCKED; mirrors create_mcp_snapshot's rule) ----
type Snap = { id: string; version: number; sha: string; tools: { name: string }[] };
const db = vi.hoisted(() => ({ snaps: [] as Snap[], writes: 0, latestReads: 0, failLatest: false, forceConflict: false }));
vi.mock('@/lib/connect/external-mcp-repo', async (orig) => {
  const real = await orig<typeof import('@/lib/connect/external-mcp-repo')>();
  return {
    ...real,
    createExternalMcpRepository: () => ({
      getEndpointUrl: async (org: string, id: string) => (org === ORG && id === EP ? `https://${HOST}/mcp` : null),
      getLatestSnapshotVersion: async () => {
        db.latestReads++;
        if (db.failLatest) throw new Error('read failed');
        return db.snaps.reduce((m, s) => Math.max(m, s.version), 0);
      },
      createSnapshot: async (_o: string, _e: string, version: number, sha: string, tools: { name: string }[]) => {
        const latest = db.snaps.reduce((m, s) => Math.max(m, s.version), 0);
        if (db.forceConflict || version !== latest + 1) throw new real.SnapshotVersionConflictError();
        db.writes++;
        const id = `snap-${version}`;
        db.snaps.push({ id, version, sha, tools: tools.map((t) => ({ name: t.name })) });
        return id;
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

const { POST } = await import('./route');

// ---- real sockets: HTTPS MCP server + CONNECT proxy ----
type Mode = 'ok' | 'malformed' | 'rpc-error' | 'hang' | 'redirect' | 'page2-500' | 'page2-invalid' | 'v2-tools';
let mode: Mode = 'ok';
let mcp: https.Server; let mcpPort = 0; let mcpConnections = 0; let mcpRequests = 0;
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
  Object.assign(db, { snaps: [], writes: 0, latestReads: 0, failLatest: false, forceConflict: false });
  mode = 'ok'; proxyMode = 'allow'; T.injectCa = true; T.timeoutMs = 3000; T.dnsCalls = 0;
  connects.length = 0; tunnels = 0; mcpConnections = 0; mcpRequests = 0; redirectTargetHits = 0;
  globalFetch = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => { globalFetch.mockRestore(); vi.unstubAllEnvs(); });

async function snapshot() {
  const req = new Request(`${ORIGIN}/api/v1/connect/mcp/endpoints/${EP}/snapshot`, {
    method: 'POST', body: '{}',
    headers: { origin: ORIGIN, 'x-tugpt-csrf': '1', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-tenant-id': ORG },
  });
  const res = await POST(req, { params: Promise.resolve({ endpointId: EP }) });
  return { status: res.status, body: await res.json() as { error?: { code: string }; version?: number; snapshotId?: string; toolCount?: number } };
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
    expect([db.writes, db.latestReads, T.dnsCalls, connects.length, mcpConnections]).toEqual([0, 0, 0, 0, 0]);
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
  it('a concurrent winner -> 409 SNAPSHOT_VERSION_CONFLICT, nothing written by the loser', async () => {
    db.forceConflict = true;
    const r = await snapshot();
    expect(r.status).toBe(409); expect(r.body.error?.code).toBe('SNAPSHOT_VERSION_CONFLICT'); expect(db.writes).toBe(0);
  });
  it('a failed version read fails closed (500), never falls back to v1', async () => {
    db.failLatest = true;
    const r = await snapshot();
    expect(r.status).toBe(500); expect(db.writes).toBe(0);
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
    expect([db.writes, db.latestReads, db.snaps.length]).toEqual([0, 0, 0]);
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
    expect(route).toMatch(/listExternalMcpTools\(\{ url: endpoint \}, egressFetch\)/);
    expect(route).not.toMatch(/(^|[^.\w])fetch\(|globalThis\.fetch|node:https?'|undici|node:net/m);
    expect(route).not.toMatch(/createSnapshot\([^)]*,\s*1\s*,/); // version is never a literal
  });
  it('runtime discovery has no fallback transport', () => {
    const body = runtime.slice(runtime.indexOf('export async function listExternalMcpTools'), runtime.indexOf('function normalizeModelName'));
    expect(body).toMatch(/fetchFn: ExternalMcpFetch,\n\): /); // required parameter
    expect(body).not.toMatch(/endpoint\.fetchFn|defaultFetch|globalThis\.fetch|[^\w.]fetch\(/);
  });
});
