import { describe, it, expect } from 'vitest';
import {
  listExternalMcpTools,
  type ExternalMcpFetch,
} from './external-mcp-tool.js';

function listFetch(): ExternalMcpFetch {
  return async (_url, init) => {
    const body = JSON.parse(init.body) as { id?: number; method: string };
    if (body.method === 'initialize') {
      return {
        status: 200,
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, sessionId: 'sess-1' } }),
      };
    }
    if (body.method === 'notifications/initialized') {
      return { status: 200, text: async () => '' };
    }
    if (body.method === 'tools/list') {
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              tools: [
                { name: 'search', description: 'Search records', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
                { name: 'create', description: 'Create a record', inputSchema: { type: 'object', properties: { body: { type: 'string' } } } },
              ],
            },
          }),
      };
    }
    return { status: 500, text: async () => '' };
  };
}

describe('listExternalMcpTools', () => {
  it('returns the endpoint tool list for the approval snapshot', async () => {
    const tools = await listExternalMcpTools(
      { url: 'https://customer.example.com/mcp', authHeader: 'Bearer tok', resolveHostname: async () => ['93.184.216.34'] },
      listFetch(),
    );
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({
      name: 'search',
      description: 'Search records',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    });
    expect(tools[1].name).toBe('create');
  });

  it('rejects a non-HTTPS endpoint', async () => {
    await expect(listExternalMcpTools({ url: 'http://customer.example.com/mcp' }, listFetch())).rejects.toThrow();
  });
});
