/**
 * REAL network tests (loopback only): a real CONNECT proxy double, a real
 * HTTPS MCP server and real TLS verification. Nothing here is mocked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEgressMcpFetch, EgressError, parseEgressProxy } from './mcp-egress';
import { deadPort, makeCertificate, MCP_HOST, opensslAvailable, startConnectProxy, startMcpServer, type ConnectProxy, type McpServer } from './mcp.test-harness';

const init = (body: object) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual' as const });
const code = async (p: Promise<unknown>) => { try { await p; return 'resolved'; } catch (e) { return e instanceof EgressError ? e.code : 'other'; } };

describe('parseEgressProxy', () => {
  it('accepts only a plain http CONNECT proxy', () => {
    expect(parseEgressProxy('http://egress-proxy.test:3128')?.port).toBe('3128');
    expect(parseEgressProxy('http://u:p@egress-proxy.test:3128')?.username).toBe('u');
    for (const bad of [undefined, '', '  ', 'not a url', 'https://egress:443', 'socks5://egress:1080', 'http://egress:3128/path', 'http://egress:3128/?x=1', 'file:///etc/passwd']) {
      expect(parseEgressProxy(bad)).toBeNull();
    }
  });
});

describe.skipIf(!opensslAvailable())('createEgressMcpFetch through a real CONNECT proxy (real sockets + TLS)', () => {
  let tlsMaterial: { key: string; cert: string };
  let server: McpServer;
  let proxy: ConnectProxy;
  const url = `https://${MCP_HOST}/mcp`;

  beforeAll(async () => {
    tlsMaterial = makeCertificate();
    server = await startMcpServer(tlsMaterial);
    proxy = await startConnectProxy({ [`${MCP_HOST}:443`]: server.port });
  });
  afterAll(async () => { await server.close(); await proxy.close(); });

  it('tunnels through the proxy with a verified TLS session and returns the reply', async () => {
    const before = proxy.connects.length;
    const res = await createEgressMcpFetch({ proxyUrl: proxy.url, ca: tlsMaterial.cert })(url, init({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text()).result.sessionId).toBe('sess-1');
    expect(proxy.connects.slice(before)).toEqual([`${MCP_HOST}:443`]);
  });

  it('refuses without a proxy and never opens a socket (no direct fallback)', async () => {
    const before = server.calls.length;
    for (const proxyUrl of [undefined, '', 'https://127.0.0.1:1', 'not a url']) {
      expect(await code(createEgressMcpFetch({ proxyUrl, ca: tlsMaterial.cert })(url, init({})))).toBe('EGRESS_NOT_CONFIGURED');
    }
    expect(server.calls.length).toBe(before);
  });

  it('refuses non-https targets before contacting the proxy', async () => {
    const before = proxy.connects.length;
    const f = createEgressMcpFetch({ proxyUrl: proxy.url, ca: tlsMaterial.cert });
    expect(await code(f(`http://${MCP_HOST}/mcp`, init({})))).toBe('EGRESS_HTTPS_ONLY');
    expect(await code(f(`https://user:pw@${MCP_HOST}/mcp`, init({})))).toBe('EGRESS_HTTPS_ONLY');
    expect(proxy.connects.length).toBe(before);
  });

  it('fails when the proxy refuses the tunnel (not allowlisted, or policy says no)', async () => {
    const f = createEgressMcpFetch({ proxyUrl: proxy.url, ca: tlsMaterial.cert });
    expect(await code(f('https://other.test.example/mcp', init({})))).toBe('EGRESS_REFUSED');
    proxy.refuse = true;
    try { expect(await code(f(url, init({})))).toBe('EGRESS_REFUSED'); } finally { proxy.refuse = false; }
  });

  it('fails when the proxy is down', async () => {
    const port = await deadPort();
    expect(await code(createEgressMcpFetch({ proxyUrl: `http://127.0.0.1:${port}`, ca: tlsMaterial.cert })(url, init({})))).toBe('EGRESS_UNREACHABLE');
  });

  it('fails when the certificate cannot be verified (no trust anchor)', async () => {
    expect(await code(createEgressMcpFetch({ proxyUrl: proxy.url })(url, init({})))).toBe('EGRESS_TLS');
  });

  it('never follows redirects: the 3xx status is returned as-is', async () => {
    server.mode = 'redirect';
    try {
      const before = proxy.connects.length;
      const res = await createEgressMcpFetch({ proxyUrl: proxy.url, ca: tlsMaterial.cert })(url, init({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
      expect(res.status).toBe(302);
      expect(proxy.connects.length).toBe(before + 1);
    } finally { server.mode = 'ok'; }
  });

  it('caps the response size', async () => {
    server.mode = 'huge';
    try {
      const f = createEgressMcpFetch({ proxyUrl: proxy.url, ca: tlsMaterial.cert, maxResponseBytes: 64 * 1024 });
      expect(await code(f(url, init({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'x', arguments: {} } })))).toBe('EGRESS_RESPONSE_TOO_LARGE');
    } finally { server.mode = 'ok'; }
  });
});
