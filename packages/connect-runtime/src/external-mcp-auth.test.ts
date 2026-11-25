import { describe, it, expect } from 'vitest';
import { createExternalMcpTool, listExternalMcpTools, type ExternalMcpFetch, type ExternalMcpToolDef } from './external-mcp-tool.js';

// B3: authenticated customer MCP. The bearer comes from the runtime's token step (deps.accessToken), which runs
// after authorization + approval and before any network call; it is never stored on the endpoint object.
const TOOL_DEF: ExternalMcpToolDef = {
  name: 'lookup_customer',
  description: 'Look up a customer record.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  permissionClass: 'read',
};
const PUBLIC = async () => ['93.184.216.34'];
const CANARY = 'tugpt-canary-b3-0000000000000000';

function server(opts: { status?: number } = {}) {
  const sent: Array<{ method: string; authorization: string | null }> = [];
  const fetchFn: ExternalMcpFetch = async (_u, init) => {
    const body = JSON.parse(init.body) as { id?: unknown; method: string };
    sent.push({ method: body.method, authorization: init.headers.authorization ?? null });
    if (opts.status && body.method === 'initialize') return { status: opts.status, text: async () => `denied ${CANARY}` };
    if (body.method === 'initialize') {
      return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }) };
    }
    if (body.method === 'notifications/initialized') return { status: 202, text: async () => '' };
    if (body.method === 'tools/list') {
      return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'x', inputSchema: { type: 'object' } }] } }) };
    }
    return { status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } }) };
  };
  return { sent, fetchFn };
}

describe('B3 bearer credential from the runtime token step', () => {
  it('sends Authorization: Bearer <deps.accessToken> on every message when the endpoint uses a credential', async () => {
    const { sent, fetchFn } = server();
    const tool = createExternalMcpTool({ url: 'https://customer.example.com/mcp', fetchFn, resolveHostname: PUBLIC, credential: 'bearer' }, TOOL_DEF);
    const out = await tool.execute({ id: 'x' }, { accessToken: CANARY, now: () => 0 });
    expect(out).toEqual({ ok: true, data: { content: 'ok' } });
    expect(sent.map((s) => s.authorization)).toEqual([`Bearer ${CANARY}`, `Bearer ${CANARY}`, `Bearer ${CANARY}`]);
  });

  it('refuses REAUTHORIZATION_REQUIRED with zero network calls when the credential endpoint gets an empty token', async () => {
    const { sent, fetchFn } = server();
    const tool = createExternalMcpTool({ url: 'https://customer.example.com/mcp', fetchFn, resolveHostname: PUBLIC, credential: 'bearer' }, TOOL_DEF);
    expect(await tool.execute({ id: 'x' }, { accessToken: '', now: () => 0 })).toEqual({ ok: false, code: 'REAUTHORIZATION_REQUIRED' });
    expect(sent).toEqual([]);
  });

  it('does not send the runtime token to endpoints without a credential (no-credential endpoints stay anonymous)', async () => {
    const { sent, fetchFn } = server();
    const tool = createExternalMcpTool({ url: 'https://customer.example.com/mcp', fetchFn, resolveHostname: PUBLIC }, TOOL_DEF);
    expect((await tool.execute({ id: 'x' }, { accessToken: CANARY, now: () => 0 })).ok).toBe(true);
    expect(sent.every((s) => s.authorization === null)).toBe(true);
  });

  it.each([401, 403])('maps HTTP %i from the server to REAUTHORIZATION_REQUIRED and never echoes the body', async (status) => {
    const { fetchFn } = server({ status });
    const tool = createExternalMcpTool({ url: 'https://customer.example.com/mcp', fetchFn, resolveHostname: PUBLIC, credential: 'bearer' }, TOOL_DEF);
    const out = await tool.execute({ id: 'x' }, { accessToken: CANARY, now: () => 0 });
    expect(out).toEqual({ ok: false, code: 'REAUTHORIZATION_REQUIRED' });
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });

  it('discovery with a per-call authHeader raises DISCOVERY_UNAUTHORIZED on 401 and its message holds no secret', async () => {
    const { fetchFn } = server({ status: 401 });
    const err = await listExternalMcpTools({ url: 'https://customer.example.com/mcp', fetchFn, resolveHostname: PUBLIC, authHeader: `Bearer ${CANARY}` }).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('DISCOVERY_UNAUTHORIZED');
    expect(String((err as Error).message)).not.toContain(CANARY);
  });
});
