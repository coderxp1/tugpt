import { describe, it, expect } from 'vitest';
import {
  assertHttpsEndpoint,
  assertPublicEndpoint,
  createExternalMcpTool,
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
