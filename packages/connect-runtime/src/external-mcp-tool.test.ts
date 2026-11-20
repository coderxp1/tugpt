import { describe, it, expect } from 'vitest';
import {
  assertHttpsEndpoint,
  assertPublicEndpoint,
  createExternalMcpTool,
  listExternalMcpTools,
  type ExternalMcpFetch,
  type ExternalMcpToolDef,
} from './external-mcp-tool.js';

const TOOL_DEF: ExternalMcpToolDef = {
  name: 'lookup_customer',
  description: 'Look up a customer record.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  permissionClass: 'read',
};

const PUBLIC = async () => ['93.184.216.34'];

function fakeMcpFetch(): ExternalMcpFetch {
  return async (_url, init) => {
    const body = JSON.parse(init.body) as { id?: number; method: string; params?: Record<string, unknown> };
    if (body.method === 'initialize') {
      return {
        status: 200,
        text: async () =>
          JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }),
      };
    }
    if (body.method === 'notifications/initialized') {
      return { status: 200, text: async () => '' };
    }
    if (body.method === 'tools/call') {
      return {
        status: 200,
        text: async () =>
          JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `result:${JSON.stringify(body.params?.arguments)}` }] } }),
      };
    }
    return { status: 500, text: async () => '' };
  };
}

describe('createExternalMcpTool', () => {
  it('executes a customer MCP tool over Streamable HTTP and returns its text', async () => {
    const tool = createExternalMcpTool(
      { url: 'https://customer.example.com/mcp', authHeader: 'Bearer tok', fetchFn: fakeMcpFetch(), resolveHostname: PUBLIC },
      TOOL_DEF,
    );
    expect(tool.provider).toBe('mcp');
    expect(tool.risk).toBe('read');
    const result = await tool.execute({ id: 'abc' }, { accessToken: 'x', now: () => 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { content: string }).content).toBe('result:{"id":"abc"}');
  });

  it('fails closed when the endpoint returns an error', async () => {
    const tool = createExternalMcpTool(
      {
        url: 'https://customer.example.com/mcp',
        resolveHostname: PUBLIC,
        fetchFn: async () => ({ status: 500, text: async () => '' }),
      },
      TOOL_DEF,
    );
    const result = await tool.execute({}, { accessToken: 'x', now: () => 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('fails closed when the endpoint resolves to a private address (SSRF)', async () => {
    const tool = createExternalMcpTool(
      { url: 'https://customer.example.com/mcp', resolveHostname: async () => ['10.0.0.1'], fetchFn: fakeMcpFetch() },
      TOOL_DEF,
    );
    const result = await tool.execute({}, { accessToken: 'x', now: () => 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('validates arguments are a JSON object', () => {
    const tool = createExternalMcpTool({ url: 'https://customer.example.com/mcp', resolveHostname: PUBLIC, fetchFn: fakeMcpFetch() }, TOOL_DEF);
    expect(tool.validate('nope' as unknown as Readonly<Record<string, unknown>>, 0).ok).toBe(false);
    expect(tool.validate({ id: 'x' }, 0).ok).toBe(true);
  });
});

describe('assertHttpsEndpoint', () => {
  it('accepts https', () => {
    expect(assertHttpsEndpoint('https://customer.example.com/mcp')).toContain('https://');
  });
  it('rejects plain http on a public host', () => {
    expect(() => assertHttpsEndpoint('http://customer.example.com/mcp')).toThrow();
  });
  it('rejects malformed URLs', () => {
    expect(() => assertHttpsEndpoint('not a url')).toThrow();
  });
});

describe('assertPublicEndpoint (SSRF)', () => {
  it('accepts a public https host', async () => {
    await expect(assertPublicEndpoint('https://customer.example.com/mcp', PUBLIC)).resolves.toContain('https://');
  });
  it('rejects a literal private IPv4', async () => {
    await expect(assertPublicEndpoint('https://10.0.0.1/', PUBLIC)).rejects.toThrow();
  });
  it('rejects a loopback IPv4', async () => {
    await expect(assertPublicEndpoint('https://127.0.0.1/', PUBLIC)).rejects.toThrow();
  });
  it('rejects a metadata address', async () => {
    await expect(assertPublicEndpoint('https://169.254.169.254/', PUBLIC)).rejects.toThrow();
  });
  it('rejects a host that resolves to a private address', async () => {
    await expect(assertPublicEndpoint('https://customer.example.com/', async () => ['192.168.1.1'])).rejects.toThrow();
  });
  it('rejects an internal hostname', async () => {
    await expect(assertPublicEndpoint('https://db.internal/', PUBLIC)).rejects.toThrow();
  });
  it('rejects a link-local IPv6', async () => {
    await expect(assertPublicEndpoint('https://[fe80::1]/', PUBLIC)).rejects.toThrow();
  });
});

describe('B-8 no direct fetch (egress proxy required)', () => {
  it('refuses to build a tool without a proxy-aware fetch (no deferred, silent failure)', () => {
    expect(() => createExternalMcpTool({ url: 'https://customer.example.com/mcp', resolveHostname: async () => ['93.184.216.34'] }, TOOL_DEF))
      .toThrow(/egress proxy required/);
  });
});

/**
 * M6: tools/call protocol details and size caps, against a scripted transport (labelled stand-in for
 * the egress fetch; the same behaviour is exercised over real sockets in apps/web mcp-chat.test.ts).
 */
describe('tools/call protocol and size caps (M6)', () => {
  const REPLY_CAP = 1024 * 1024; // MAX_MCP_REPLY_BYTES
  const TEXT_CAP = 64 * 1024; // MAX_MCP_RESULT_TEXT_BYTES
  type Sent = { method: string; headers: Record<string, string> };
  const result = (id: unknown, text: string) => JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
  function scripted(opts: { initVersion?: unknown; reply?: (id: unknown, method: string) => { text: string; contentType?: string } } = {}) {
    const sent: Sent[] = [];
    const fetchFn: ExternalMcpFetch = async (_u, init) => {
      const body = JSON.parse(init.body) as { id?: unknown; method: string };
      sent.push({ method: body.method, headers: init.headers });
      if (body.method === 'initialize') {
        const version = 'initVersion' in opts ? opts.initVersion : '2025-06-18';
        return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: version, capabilities: {} } }),
          headers: { get: (n: string) => (n === 'mcp-session-id' ? 'sess-1' : null) } };
      }
      if (body.method === 'notifications/initialized') return { status: 202, text: async () => '' };
      const r = opts.reply ? opts.reply(body.id, body.method) : { text: result(body.id, 'ok') };
      return { status: 200, text: async () => r.text, headers: { get: (n: string) => (n === 'content-type' ? (r.contentType ?? 'application/json') : null) } };
    };
    const endpoint = { url: 'https://customer.example.com/mcp', fetchFn, resolveHostname: PUBLIC };
    return { sent, fetchFn, endpoint, tool: createExternalMcpTool(endpoint, TOOL_DEF) };
  }
  const run = (t: ReturnType<typeof createExternalMcpTool>) => t.execute({ id: 'x' }, { accessToken: '', now: () => 0 });

  it('exports the caps and supported revisions it enforces', async () => {
    const m = await import('./external-mcp-tool.js');
    expect([m.MAX_MCP_REPLY_BYTES, m.MAX_MCP_RESULT_TEXT_BYTES]).toEqual([REPLY_CAP, TEXT_CAP]);
    expect(m.SUPPORTED_MCP_PROTOCOL_VERSIONS).toEqual(['2025-06-18', '2025-03-26']);
  });

  it('sends the negotiated MCP-Protocol-Version on every message after initialize (not on initialize)', async () => {
    const { sent, tool } = scripted();
    expect((await run(tool)).ok).toBe(true);
    expect(sent.map((x) => [x.method, x.headers['mcp-protocol-version'] ?? null, x.headers['mcp-session-id'] ?? null])).toEqual([
      ['initialize', null, null], ['notifications/initialized', '2025-06-18', 'sess-1'], ['tools/call', '2025-06-18', 'sess-1'],
    ]);
  });

  it('accepts the older 2025-03-26 revision and sends that one back', async () => {
    const { sent, tool } = scripted({ initVersion: '2025-03-26' });
    expect((await run(tool)).ok).toBe(true);
    expect(sent.slice(1).map((x) => x.headers['mcp-protocol-version'])).toEqual(['2025-03-26', '2025-03-26']);
  });

  it.each([['1999-01-01'], [null], [42]])('an unsupported or missing negotiated version (%s) aborts before any other message', async (v) => {
    const { sent, tool } = scripted({ initVersion: v });
    expect(await run(tool)).toEqual({ ok: false, code: 'PROVIDER_UNAVAILABLE' });
    expect(sent.map((x) => x.method)).toEqual(['initialize']);
  });

  it('a server->client request that reuses our request id is not taken as our response (SSE)', async () => {
    const { tool } = scripted({ reply: (id) => ({
      contentType: 'text/event-stream',
      text: `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, method: 'roots/list' })}\n\nevent: message\ndata: ${result(id, 'real-answer')}\n\n`,
    }) });
    const r = await run(tool);
    expect(r).toEqual({ ok: true, data: { content: 'real-answer' } });
  });

  it('a text result of exactly the cap passes; one byte more is OUTPUT_TOO_LARGE and nothing is returned', async () => {
    const at = scripted({ reply: (id) => ({ text: result(id, 'y'.repeat(TEXT_CAP)) }) });
    const ok = await run(at.tool);
    expect(ok.ok && (ok.data as { content: string }).content.length).toBe(TEXT_CAP);
    const over = scripted({ reply: (id) => ({ text: result(id, 'y'.repeat(TEXT_CAP + 1)) }) });
    expect(await run(over.tool)).toEqual({ ok: false, code: 'OUTPUT_TOO_LARGE' });
  });

  it('a reply body over the reply cap is OUTPUT_TOO_LARGE even when the transport delivered it', async () => {
    const { tool } = scripted({ reply: (id) => ({ text: result(id, 'z'.repeat(REPLY_CAP)) }) });
    expect(await run(tool)).toEqual({ ok: false, code: 'OUTPUT_TOO_LARGE' });
  });

  it('discovery: an oversized tools/list reply is DISCOVERY_TOO_LARGE, never a tool list', async () => {
    const { endpoint, fetchFn } = scripted({ reply: (id) => ({ text: JSON.stringify({ jsonrpc: '2.0', id, result: {
      tools: [{ name: 'a', inputSchema: { type: 'object' } }], _meta: { pad: 'p'.repeat(REPLY_CAP) } } }) }) });
    await expect(listExternalMcpTools(endpoint, fetchFn)).rejects.toMatchObject({ name: 'McpDiscoveryError', code: 'DISCOVERY_TOO_LARGE' });
  });
});
