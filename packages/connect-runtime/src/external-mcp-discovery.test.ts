/**
 * Discovery contract for snapshots (Agent 2 M4). MOCKED TRANSPORT: the fetch
 * is an in-memory fake; real sockets/proxy/TLS are covered in the web route
 * test (snapshot-egress.test.ts). Every failure must throw: a partial tool
 * list is never returned, so nothing partial can be persisted.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  listExternalMcpTools, McpDiscoveryError, MAX_SNAPSHOT_TOOLS,
  type ExternalMcpFetch, type ExternalMcpFetchResponse,
} from './external-mcp-tool.js';

const EP = { url: 'https://customer.example.com/mcp', resolveHostname: async () => ['93.184.216.34'] };
type Msg = { jsonrpc?: string; id?: number; method: string; params?: { cursor?: string } };
type Reply = ExternalMcpFetchResponse | ((m: Msg, h: Record<string, string>) => ExternalMcpFetchResponse);
const json = (o: unknown, status = 200, headers: Record<string, string> = {}): ExternalMcpFetchResponse =>
  ({ status, text: async () => JSON.stringify(o), headers: { get: (n) => headers[n.toLowerCase()] ?? null } });
const ok = (id: number | undefined, result: unknown) => json({ jsonrpc: '2.0', id, result });
const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: `d ${name}`, inputSchema: { type: 'object' }, ...extra });

function server(handlers: Partial<Record<string, Reply | Reply[]>>) {
  const calls: { msg: Msg; headers: Record<string, string> }[] = [];
  const counters: Record<string, number> = {};
  const fetchFn: ExternalMcpFetch = async (_u, init) => {
    const msg = JSON.parse(init.body) as Msg;
    calls.push({ msg, headers: init.headers });
    let h = handlers[msg.method];
    if (Array.isArray(h)) { const i = counters[msg.method] ?? 0; counters[msg.method] = i + 1; h = h[Math.min(i, h.length - 1)]; }
    if (!h) return json({}, 500);
    return typeof h === 'function' ? h(msg, init.headers) : h;
  };
  return { fetchFn, calls };
}
const happy = (tools: unknown[] = [tool('search'), tool('create')]) => ({
  initialize: (m: Msg) => ok(m.id, { protocolVersion: '2025-06-18', capabilities: {} }),
  'notifications/initialized': json('', 202),
  'tools/list': (m: Msg) => ok(m.id, { tools }),
});
async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return 'RESOLVED'; } catch (e) { return e instanceof McpDiscoveryError ? e.code : `OTHER:${(e as Error).message}`; }
}

describe('listExternalMcpTools: transport (no fallback)', () => {
  it('throws without an explicit fetch and never uses endpoint.fetchFn', async () => {
    const viaEndpoint = vi.fn(happy()['tools/list'] as never);
    const res = listExternalMcpTools({ ...EP, fetchFn: viaEndpoint } as never, undefined as never);
    await expect(res).rejects.toThrow(/egress proxy required/);
    expect(viaEndpoint).not.toHaveBeenCalled();
  });
  it('uses only the passed fetch even when endpoint.fetchFn is set', async () => {
    const viaEndpoint = vi.fn();
    const s = server(happy());
    await listExternalMcpTools({ ...EP, fetchFn: viaEndpoint as never }, s.fetchFn);
    expect(viaEndpoint).not.toHaveBeenCalled();
    expect(s.calls.length).toBe(3);
  });
  it('does not touch the network at all for a non-https or private target', async () => {
    const s = server(happy());
    await expect(listExternalMcpTools({ url: 'http://customer.example.com/mcp' }, s.fetchFn)).rejects.toThrow();
    await expect(listExternalMcpTools({ url: 'https://internal.example/mcp', resolveHostname: async () => ['10.0.0.5'] }, s.fetchFn)).rejects.toThrow();
    await expect(listExternalMcpTools({ url: 'https://meta.example/mcp', resolveHostname: async () => ['169.254.169.254'] }, s.fetchFn)).rejects.toThrow();
    expect(s.calls.length).toBe(0);
  });
});

describe('listExternalMcpTools: protocol', () => {
  it('returns validated tools; notification has no id; session id taken from the Mcp-Session-Id header', async () => {
    const s = server({ ...happy(), initialize: (m) => json({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18' } }, 200, { 'mcp-session-id': 'hdr-sess' }) });
    const tools = await listExternalMcpTools(EP, s.fetchFn);
    expect(tools.map((t) => t.name)).toEqual(['search', 'create']);
    const note = s.calls.find((c) => c.msg.method === 'notifications/initialized')!;
    expect('id' in note.msg).toBe(false);
    expect(s.calls.slice(1).every((c) => c.headers['mcp-session-id'] === 'hdr-sess')).toBe(true);
  });
  it('parses an SSE reply and picks the message with the matching id', async () => {
    const sse = (m: Msg) => ({ status: 200, text: async () => `event: message\ndata: {"jsonrpc":"2.0","method":"log"}\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [tool('a')] } })}\n\n` });
    const s = server({ ...happy(), 'tools/list': sse });
    expect((await listExternalMcpTools(EP, s.fetchFn)).map((t) => t.name)).toEqual(['a']);
  });
  it('follows pagination and returns all pages', async () => {
    const s = server({ ...happy(), 'tools/list': [(m) => ok(m.id, { tools: [tool('p1')], nextCursor: 'c2' }), (m) => ok(m.id, { tools: [tool('p2')] })] });
    expect((await listExternalMcpTools(EP, s.fetchFn)).map((t) => t.name)).toEqual(['p1', 'p2']);
    expect(s.calls.filter((c) => c.msg.method === 'tools/list')[1].msg.params).toEqual({ cursor: 'c2' });
  });
  it('accepts a legitimately empty tool list', async () => {
    expect(await listExternalMcpTools(EP, server(happy([])).fetchFn)).toEqual([]);
  });
});

describe('listExternalMcpTools: every failure throws (all-or-nothing)', () => {
  const cases: [string, Partial<Record<string, Reply | Reply[]>>, string][] = [
    ['initialize HTTP 500', { initialize: json({}, 500) }, 'DISCOVERY_HTTP_STATUS'],
    ['initialize redirect 302 (not followed)', { initialize: json({}, 302, { location: 'https://evil.example/' }) }, 'DISCOVERY_HTTP_STATUS'],
    ['initialize JSON-RPC error', { initialize: (m) => json({ jsonrpc: '2.0', id: m.id, error: { code: -32600, message: 'no' } }) }, 'DISCOVERY_RPC_ERROR'],
    ['initialize not JSON', { initialize: { status: 200, text: async () => '<html>' } }, 'DISCOVERY_MALFORMED'],
    ['initialize wrong id', { initialize: () => ok(99, {}) }, 'DISCOVERY_MALFORMED'],
    ['initialize not jsonrpc 2.0', { initialize: (m) => json({ jsonrpc: '1.0', id: m.id, result: {} }) }, 'DISCOVERY_MALFORMED'],
    ['initialize result missing', { initialize: (m) => json({ jsonrpc: '2.0', id: m.id }) }, 'DISCOVERY_MALFORMED'],
    ['initialized notification rejected', { 'notifications/initialized': json({}, 400) }, 'DISCOVERY_HTTP_STATUS'],
    ['tools/list JSON-RPC error (was: empty snapshot)', { 'tools/list': (m) => json({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'x' } }) }, 'DISCOVERY_RPC_ERROR'],
    ['tools/list tools not an array', { 'tools/list': (m) => ok(m.id, { tools: { a: 1 } }) }, 'DISCOVERY_MALFORMED'],
    ['tools/list result without tools', { 'tools/list': (m) => ok(m.id, {}) }, 'DISCOVERY_MALFORMED'],
    ['tool without name', { 'tools/list': (m) => ok(m.id, { tools: [tool('ok'), { description: 'x', inputSchema: { type: 'object' } }] }) }, 'DISCOVERY_INVALID_TOOL'],
    ['tool name with forbidden chars', { 'tools/list': (m) => ok(m.id, { tools: [tool('rm -rf /')] }) }, 'DISCOVERY_INVALID_TOOL'],
    ['tool name too long', { 'tools/list': (m) => ok(m.id, { tools: [tool('a'.repeat(65))] }) }, 'DISCOVERY_INVALID_TOOL'],
    ['duplicate tool names', { 'tools/list': (m) => ok(m.id, { tools: [tool('a'), tool('a')] }) }, 'DISCOVERY_INVALID_TOOL'],
    ['inputSchema missing', { 'tools/list': (m) => ok(m.id, { tools: [{ name: 'a' }] }) }, 'DISCOVERY_INVALID_TOOL'],
    ['inputSchema not an object schema', { 'tools/list': (m) => ok(m.id, { tools: [tool('a', { inputSchema: { type: 'string' } })] }) }, 'DISCOVERY_INVALID_TOOL'],
    ['description too long', { 'tools/list': (m) => ok(m.id, { tools: [tool('a', { description: 'x'.repeat(2001) })] }) }, 'DISCOVERY_INVALID_TOOL'],
    ['partial: page 2 HTTP 500', { 'tools/list': [(m) => ok(m.id, { tools: [tool('p1')], nextCursor: 'c2' }), json({}, 500)] }, 'DISCOVERY_HTTP_STATUS'],
    ['partial: page 2 invalid tool', { 'tools/list': [(m) => ok(m.id, { tools: [tool('p1')], nextCursor: 'c2' }), (m) => ok(m.id, { tools: [{ name: '' }] })] }, 'DISCOVERY_INVALID_TOOL'],
    ['partial: duplicate across pages', { 'tools/list': [(m) => ok(m.id, { tools: [tool('p1')], nextCursor: 'c2' }), (m) => ok(m.id, { tools: [tool('p1')] })] }, 'DISCOVERY_INVALID_TOOL'],
    ['nextCursor not a string', { 'tools/list': (m) => ok(m.id, { tools: [], nextCursor: 7 }) }, 'DISCOVERY_MALFORMED'],
    ['endless pagination', { 'tools/list': (m) => ok(m.id, { tools: [], nextCursor: 'again' }) }, 'DISCOVERY_TOO_LARGE'],
    ['too many tools', { 'tools/list': (m) => ok(m.id, { tools: Array.from({ length: MAX_SNAPSHOT_TOOLS + 1 }, (_, i) => tool(`t${i}`)) }) }, 'DISCOVERY_TOO_LARGE'],
  ];
  it.each(cases)('%s -> %s', async (_n, override, expected) => {
    expect(await code(listExternalMcpTools(EP, server({ ...happy(), ...override }).fetchFn))).toBe(expected);
  });
  it('propagates transport errors unchanged (route maps them to 503/504)', async () => {
    const boom = Object.assign(new Error('EGRESS_UNREACHABLE'), { code: 'EGRESS_UNREACHABLE' });
    await expect(listExternalMcpTools(EP, async () => { throw boom; })).rejects.toBe(boom);
  });
});
