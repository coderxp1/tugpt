/**
 * MCP Streamable HTTP session contract for chat execution (createExternalMcpTool) and snapshot discovery
 * (listExternalMcpTools). Spec 2025-06-18, "Session Management":
 *   - a server that uses sessions returns the id ONLY in the `Mcp-Session-Id` header of the initialize
 *     response; the client sends it on every later message;
 *   - a server without that header is stateless; the client sends no session header;
 *   - `notifications/initialized` is a notification: no `id`, answered 2xx.
 *
 * MOCKED: the transport. `spec` below is an in-memory ExternalMcpFetch that implements the server side of
 * the contract strictly (400 without a session, 404 for an unknown one, 400 for a notification with an id).
 * The same behaviour over real sockets, TLS and the egress proxy is tested in
 * apps/web/src/lib/chat/mcp-chat.test.ts against mcp.test-harness's HTTPS server.
 */
import { describe, expect, it } from 'vitest';
import { createExternalMcpTool, listExternalMcpTools, type ExternalMcpFetch, type ExternalMcpToolDef } from './external-mcp-tool.js';

const PUBLIC = async () => ['93.184.216.34'];
const URL = 'https://customer.example.com/mcp';
const DEF: ExternalMcpToolDef = { name: 'lookup', description: 'd', inputSchema: { type: 'object' }, permissionClass: 'read' };
const deps = { accessToken: 'x', now: () => 0 };

interface Seen { method: string; hasId: boolean; id: unknown; session: string | undefined; status: number }
interface Opts {
  stateful?: boolean;
  sessionHeader?: string;
  bodySessionId?: string;
  notifyStatus?: number;
  callReply?: (id: unknown) => { status?: number; body: string; contentType?: string };
}

function spec(o: Opts = {}) {
  const seen: Seen[] = [];
  const issued = o.sessionHeader ?? 'sid-7f3a';
  const stateful = o.stateful ?? true;
  const fetchFn: ExternalMcpFetch = async (_url, init) => {
    const msg = JSON.parse(init.body) as { id?: unknown; method: string; jsonrpc: string };
    const session = init.headers['mcp-session-id'];
    const reply = (status: number, body = '', headers: Record<string, string> = {}) => {
      seen.push({ method: msg.method, hasId: 'id' in msg, id: msg.id, session, status });
      return { status, text: async () => body, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } };
    };
    if (msg.jsonrpc !== '2.0') return reply(400);
    if (msg.method === 'initialize') {
      const result: Record<string, unknown> = { protocolVersion: '2025-06-18', capabilities: { tools: {} } };
      if (o.bodySessionId) result.sessionId = o.bodySessionId; // a non-protocol field a client must ignore
      return reply(200, JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), stateful ? { 'mcp-session-id': issued, 'content-type': 'application/json' } : { 'content-type': 'application/json' });
    }
    if (stateful) {
      if (session === undefined) return reply(400);
      if (session !== issued) return reply(404);
    } else if (session !== undefined) {
      return reply(400); // this stateless server rejects a session it never issued
    }
    if (msg.method === 'notifications/initialized') return reply('id' in msg ? 400 : (o.notifyStatus ?? 202));
    if (msg.method === 'tools/list') return reply(200, JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] } }));
    if (msg.method === 'tools/call') {
      const r = o.callReply ? o.callReply(msg.id) : { body: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'hello' }] } }) };
      return reply(r.status ?? 200, r.body, r.contentType ? { 'content-type': r.contentType } : {});
    }
    return reply(404);
  };
  return { fetchFn, seen };
}

const run = (fetchFn: ExternalMcpFetch) => createExternalMcpTool({ url: URL, fetchFn, resolveHostname: PUBLIC }, DEF).execute({ q: 1 }, deps);

describe('chat execution: session id only from the Mcp-Session-Id header', () => {
  it('S1 sends the header from initialize on the notification and on tools/call', async () => {
    const s = spec();
    expect(await run(s.fetchFn)).toEqual({ ok: true, data: { content: 'hello' } });
    expect(s.seen.map((x) => [x.method, x.session, x.status])).toEqual([
      ['initialize', undefined, 200], ['notifications/initialized', 'sid-7f3a', 202], ['tools/call', 'sid-7f3a', 200],
    ]);
  });

  it('S2 the notification carries no id; requests do', async () => {
    const s = spec();
    await run(s.fetchFn);
    expect(s.seen.find((x) => x.method === 'notifications/initialized')!.hasId).toBe(false);
    expect(s.seen.filter((x) => x.method !== 'notifications/initialized').every((x) => x.hasId && typeof x.id === 'number')).toBe(true);
  });

  it('S3 a session id in the initialize RESULT BODY is ignored (stateless server, no header sent)', async () => {
    const s = spec({ stateful: false, bodySessionId: 'attacker-chosen' });
    expect(await run(s.fetchFn)).toEqual({ ok: true, data: { content: 'hello' } });
    expect(s.seen.every((x) => x.session === undefined)).toBe(true);
  });

  it('S4 a body sessionId never replaces the header', async () => {
    const s = spec({ bodySessionId: 'body-value' });
    await run(s.fetchFn);
    expect(s.seen.slice(1).every((x) => x.session === 'sid-7f3a')).toBe(true);
  });

  it('S5 a header that is not visible ASCII is refused before any further request', async () => {
    const s = spec({ sessionHeader: 'bad\u0007id' });
    expect(await run(s.fetchFn)).toEqual({ ok: false, code: 'PROVIDER_UNAVAILABLE' });
    expect(s.seen.map((x) => x.method)).toEqual(['initialize']);
  });

  it.each([400, 404, 500])('S6 the notification answered %i aborts before tools/call (no swallowed error)', async (status) => {
    const s = spec({ notifyStatus: status });
    expect(await run(s.fetchFn)).toEqual({ ok: false, code: 'PROVIDER_UNAVAILABLE' });
    expect(s.seen.some((x) => x.method === 'tools/call')).toBe(false);
  });
});

describe('chat execution: strict replies', () => {
  // Stateless server: the reply itself is the only thing that can fail the call, so each case tests
  // the reply check and nothing else (a stateful server would also catch the old client's missing header).
  const bad = (body: (id: unknown) => string, extra: Partial<{ status: number; contentType: string }> = {}) =>
    spec({ stateful: false, callReply: (id) => ({ body: body(id), ...extra }) });
  it.each([
    ['JSON-RPC error', bad((id) => JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'no' } }))],
    ['reply for another id', bad(() => JSON.stringify({ jsonrpc: '2.0', id: 999, result: { content: [] } }))],
    ['no jsonrpc member', bad((id) => JSON.stringify({ id, result: { content: [] } }))],
    ['result is not an object', bad((id) => JSON.stringify({ jsonrpc: '2.0', id, result: 'text' }))],
    ['content is not an array', bad((id) => JSON.stringify({ jsonrpc: '2.0', id, result: { content: 'text' } }))],
    ['not JSON', bad(() => '<html>gateway</html>')],
    ['HTTP 202 for a request', bad((id) => JSON.stringify({ jsonrpc: '2.0', id, result: { content: [] } }), { status: 202 })],
    ['HTTP 302', bad(() => '', { status: 302 })],
  ])('S7 %s -> PROVIDER_UNAVAILABLE', async (_n, s) => {
    expect(await run(s.fetchFn)).toEqual({ ok: false, code: 'PROVIDER_UNAVAILABLE' });
  });

  // Agent 2 (MCP reliability): a well-formed result with isError is the TOOL refusing, not the endpoint being
  // unreachable. Distinct code, and the tool's text is still never returned.
  it('S7b isError: true -> TOOL_ERROR (well-formed reply, tool refused)', async () => {
    const s = bad((id) => JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'boom' }], isError: true } }));
    expect(await run(s.fetchFn)).toEqual({ ok: false, code: 'TOOL_ERROR' });
  });

  it('S8 SSE: skips a preceding server notification and joins multi-line data', async () => {
    const s = spec({
      callReply: (id) => ({
        contentType: 'text/event-stream',
        body: `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n`
          + `event: message\nid: 9\ndata: {"jsonrpc":"2.0","id":${JSON.stringify(id)},\ndata: "result":{"content":[{"type":"text","text":"sse ok"}]}}\n\n`,
      }),
    });
    expect(await run(s.fetchFn)).toEqual({ ok: true, data: { content: 'sse ok' } });
  });

  it('S9 non-text content parts are dropped, not stringified', async () => {
    const s = spec({ callReply: (id) => ({ body: JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'image', data: 'AAA' }, { type: 'text', text: 'a' }, { type: 'text', text: 5 }] } }) }) });
    expect(await run(s.fetchFn)).toEqual({ ok: true, data: { content: 'a' } });
  });
});

describe('snapshot discovery: same session contract', () => {
  it('D1 uses the header session for the notification and tools/list', async () => {
    const s = spec();
    expect((await listExternalMcpTools({ url: URL, resolveHostname: PUBLIC }, s.fetchFn)).map((t) => t.name)).toEqual(['lookup']);
    expect(s.seen.slice(1).every((x) => x.session === 'sid-7f3a')).toBe(true);
    expect(s.seen.find((x) => x.method === 'notifications/initialized')!.hasId).toBe(false);
  });

  it('D2 ignores a body sessionId (M4 fell back to it when the header was absent)', async () => {
    const s = spec({ stateful: false, bodySessionId: 'attacker-chosen' });
    await listExternalMcpTools({ url: URL, resolveHostname: PUBLIC }, s.fetchFn);
    expect(s.seen.every((x) => x.session === undefined)).toBe(true);
  });
});
