/**
 * Customer MCP in chat (B-9), end to end through the real code path.
 *
 * REAL: Agent 2's listActiveMcpTools + mcpConnectionDirectory, connect-runtime's
 * ConnectToolRuntime + createExternalMcpTool (incl. its SSRF floor), the chat
 * toolset (lib/chat/connect.ts), the registry/gate (lib/chat/mcp.ts), the
 * proxy-only transport (lib/chat/mcp-egress.ts), the turn loop (lib/chat/turn.ts),
 * a CONNECT proxy double and an HTTPS MCP server on loopback, real TLS.
 * FAKE: the database (mcp.test-harness FakeDb, SQL semantics reproduced from
 * the migrations) and the MCP audit sink (in memory). The production default
 * has NO MCP audit sink, which keeps MCP closed; see the last describe block.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ToolAuditEvent } from '@tugpt/connect-runtime';
import { buildChatToolset, conflictingAttachments, toolAvailable } from './connect';
import { listExternalMcpTools } from '@tugpt/connect-runtime';
import { createEgressMcpFetch } from './mcp-egress';
import { loadChatToolRegistry, mcpUnavailableReason, runnableEndpoints, type McpAuditSink, type McpDeps } from './mcp';
import { argumentsSha256 } from './approval.server';
import { canonicalJson, runTurn, type TurnEvent } from './turn';
import type { WireMessage } from './openai-compatible';
import { listCapabilities, type CapabilityRow } from './store';
import { toolLabel, toolProblem } from '../connect-ui/chat-errors';
import {
  approve, deadPort, emptyState, fakeDb, fakeTrustedDb, makeCertificate, MCP_HOST, opensslAvailable, startConnectProxy, startMcpServer,
  type ConnectProxy, type FakeState, type McpServer,
} from './mcp.test-harness';

const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const OWNER_A = 'a0000000-0000-4000-8000-0000000000a1';
const MEMBER_A = 'a0000000-0000-4000-8000-0000000000a2';
const ADMIN_B = 'b0000000-0000-4000-8000-0000000000b1';
const EP_A = 'e0000000-0000-4000-8000-00000000000a';
const EP_A_PENDING = 'e0000000-0000-4000-8000-00000000000b';
const EP_A_SECOND = 'e0000000-0000-4000-8000-00000000000c';
const EP_B = 'e0000000-0000-4000-8000-00000000000d';
const THREAD = 'c0000000-0000-4000-8000-000000000001';
const URL_A = `https://${MCP_HOST}/mcp`;
const OBJ = { type: 'object', properties: { q: { type: 'string' } } };

const sha = (args: object) => createHash('sha256').update(canonicalJson(args)).digest('hex');

function seed(): FakeState {
  const s = emptyState();
  s.members = { [ORG_A]: { [OWNER_A]: 'owner', [MEMBER_A]: 'member' }, [ORG_B]: { [ADMIN_B]: 'admin' } };
  const ep = (id: string, org: string, name: string, status = 'active', auth: string | null = null) =>
    ({ id, organization_id: org, display_name: name, url: URL_A, status, auth_connection_id: auth });
  s.endpoints = [ep(EP_A, ORG_A, 'Acme Docs MCP'), ep(EP_A_PENDING, ORG_A, 'Pending MCP', 'pending'), ep(EP_A_SECOND, ORG_A, 'Second MCP'), ep(EP_B, ORG_B, 'Org B MCP')];
  const snap = (id: string, org: string, endpoint: string, version: number, approved = true) =>
    ({ id, organization_id: org, endpoint_id: endpoint, version, approved_at: approved ? '2026-11-15T00:00:00Z' : null, revoked_at: null });
  s.snapshots = [snap('s-a1', ORG_A, EP_A, 1), snap('s-p1', ORG_A, EP_A_PENDING, 1), snap('s-c1', ORG_A, EP_A_SECOND, 1), snap('s-b1', ORG_B, EP_B, 1)];
  const tool = (snapshot: string, org: string, name: string, cls: string) =>
    ({ snapshot_id: snapshot, organization_id: org, name, description: `${name} tool`, input_schema: OBJ, permission_class: cls });
  s.tools = [
    tool('s-a1', ORG_A, 'search_docs', 'read'), tool('s-a1', ORG_A, 'create_ticket', 'write'), tool('s-a1', ORG_A, 'delete_project', 'irreversible'),
    tool('s-p1', ORG_A, 'pending_tool', 'read'), tool('s-c1', ORG_A, 'search_docs', 'read'), tool('s-b1', ORG_B, 'search_docs', 'read'),
  ];
  return s;
}

describe.skipIf(!opensslAvailable())('customer MCP in chat: real runtime, real proxy, real MCP server', () => {
  let tlsMaterial: { key: string; cert: string };
  let server: McpServer;
  let proxy: ConnectProxy;
  let state: FakeState;
  let audits: (ToolAuditEvent & { endpointId: string })[];
  let auditFails: boolean;
  const audit: McpAuditSink = { async record(e) { if (auditFails) throw new Error('down'); audits.push(e); } };
  const resolveHostname = async () => ['93.184.216.34'];
  let deps: McpDeps;

  beforeAll(async () => {
    tlsMaterial = makeCertificate();
    server = await startMcpServer(tlsMaterial);
    proxy = await startConnectProxy({ [`${MCP_HOST}:443`]: server.port });
  });
  afterAll(async () => { await server.close(); await proxy.close(); });
  beforeEach(() => {
    state = seed();
    audits = [];
    auditFails = false;
    server.mode = 'ok';
    server.sessionMode = 'stateful';
    server.onTool = (name, args) => ({ text: `${name}:${JSON.stringify(args)}` });
    proxy.refuse = false;
    deps = {
      env: { TUGPT_CUSTOMER_MCP_ENABLED: 'true', TUGPT_CHAT_MCP_EXECUTION_ENABLED: 'true', CONNECT_EGRESS_PROXY: proxy.url },
      audit, resolveHostname,
      fetchFn: createEgressMcpFetch({ proxyUrl: proxy.url, ca: tlsMaterial.cert }),
    };
  });

  async function session(user: string, org = ORG_A, d: McpDeps = deps) {
    const db = fakeDb(state, user);
    const registry = await loadChatToolRegistry(db, org, { ...d, serviceDb: fakeTrustedDb(state) as never });
    const rows = await listCapabilities(db, org);
    const pick = (endpoint: string, name: string) => rows.find((r) => r.connectionId === endpoint && r.capabilityKey === `external.${name}`) as CapabilityRow;
    const toolset = (attached: CapabilityRow[]) => buildChatToolset(db, { organizationId: org, userId: user, threadId: THREAD }, attached, { registry, mcp: d });
    return { db, registry, rows, pick, toolset };
  }
  const call = (name: string, args: Record<string, unknown>, id = `call-${Math.random()}`) => ({ id, name, arguments: args });

  describe('availability in the @ picker', () => {
    it('offers tools of an active endpoint with an approved snapshot, with the stored permission class', async () => {
      const { registry, rows, pick } = await session(OWNER_A);
      for (const n of ['search_docs', 'create_ticket', 'delete_project']) expect(toolAvailable(pick(EP_A, n), registry)).toBe(true);
      expect(pick(EP_A, 'create_ticket').permissionClass).toBe('write');
      expect(registry.mcp.find((m) => m.capability === 'external.create_ticket')?.tool.risk).toBe('write');
      expect(registry.mcp.find((m) => m.capability === 'external.search_docs' && m.endpointId === EP_A)?.tool.risk).toBe('read');
      expect(registry.mcp.find((m) => m.capability === 'external.delete_project')?.tool.risk).toBe('write');
      expect(rows.some((r) => r.connectionId === EP_A_PENDING)).toBe(false);
    });

    it('hides inactive endpoints and unapproved snapshots', async () => {
      state.endpoints.find((e) => e.id === EP_A)!.status = 'disabled';
      state.snapshots.find((s) => s.id === 's-c1')!.approved_at = null;
      const { registry } = await session(OWNER_A);
      expect(registry.mcp.filter((m) => m.endpointId === EP_A || m.endpointId === EP_A_SECOND)).toEqual([]);
    });

    it('blocks an endpoint whose newest snapshot is not approved, even if an older one is', async () => {
      state.snapshots.push({ id: 's-a2', organization_id: ORG_A, endpoint_id: EP_A, version: 2, approved_at: null, revoked_at: null });
      const { registry, pick } = await session(OWNER_A);
      expect(pick(EP_A, 'search_docs')).toBeDefined();
      expect(toolAvailable(pick(EP_A, 'search_docs'), registry)).toBe(false);
    });

    it('blocks endpoints that need a stored credential (not resolvable yet)', async () => {
      state.endpoints.find((e) => e.id === EP_A)!.auth_connection_id = 'f0000000-0000-4000-8000-000000000001';
      const { registry, pick } = await session(OWNER_A);
      expect(toolAvailable(pick(EP_A, 'search_docs'), registry)).toBe(false);
    });

    it('decides runnability with member-granted columns only (url / auth_connection_id are hidden from members)', async () => {
      // Regression (M5 real-PostgREST run): the member client is refused any query that touches a hidden column.
      const db = fakeDb(state, OWNER_A);
      const hidden = await db.from('external_tool_endpoints').select('id, auth_connection_id').eq('organization_id', ORG_A);
      expect(hidden.error).toMatchObject({ code: '42501' });
      expect((await db.from('external_tool_endpoints').select('id, status').eq('auth_connection_id', null)).error).toMatchObject({ code: '42501' });
      expect([...(await runnableEndpoints(db, ORG_A))]).toContain(EP_A);
      const { registry, pick } = await session(OWNER_A);
      expect(toolAvailable(pick(EP_A, 'search_docs'), registry)).toBe(true);
    });

    it('a stored credential is refused on the trusted path (resolve_mcp_execution), not by reading the hidden column', async () => {
      state.endpoints.find((e) => e.id === EP_A)!.auth_connection_id = 'f0000000-0000-4000-8000-000000000001';
      const db = fakeDb(state, OWNER_A);
      expect([...(await runnableEndpoints(db, ORG_A))]).toContain(EP_A);
      const resolved = await fakeTrustedDb(state).rpc('resolve_mcp_execution', { p_organization_id: ORG_A, p_endpoint_id: EP_A });
      expect(resolved.error ?? null).toBeNull();
      expect(resolved.data).toBeNull();
      const { registry, pick } = await session(OWNER_A);
      expect(toolAvailable(pick(EP_A, 'search_docs'), registry)).toBe(false);
    });

    it('requires the stored permission class to match the capability row', async () => {
      const { registry, pick } = await session(OWNER_A);
      expect(toolAvailable({ ...pick(EP_A, 'create_ticket'), permissionClass: 'read' }, registry)).toBe(false);
    });

    it('rejects tools with a non-object input schema', async () => {
      state.tools.find((t) => t.name === 'search_docs' && t.snapshot_id === 's-a1')!.input_schema = { type: 'string' };
      const { registry, pick } = await session(OWNER_A);
      expect(toolAvailable(pick(EP_A, 'search_docs'), registry)).toBe(false);
    });

    it('members get no MCP tools (external_tool_* RLS is owner/admin only), though the picker lists them', async () => {
      const { registry, rows, pick } = await session(MEMBER_A);
      expect(rows.some((r) => r.connectionId === EP_A)).toBe(true);
      expect(registry.mcp).toEqual([]);
      expect(toolAvailable(pick(EP_A, 'search_docs'), registry)).toBe(false);
    });

    it('flags two endpoints offering the same tool name in one message', async () => {
      const { registry, pick } = await session(OWNER_A);
      expect(conflictingAttachments([pick(EP_A, 'search_docs'), pick(EP_A_SECOND, 'search_docs')], registry))
        .toEqual({ providers: ['Acme Docs MCP', 'Second MCP'], toolName: 'search_docs' });
    });
  });

  describe('organization isolation', () => {
    it('never lists another organization\'s endpoints', async () => {
      const a = await session(OWNER_A);
      expect(a.registry.mcp.some((m) => m.endpointId === EP_B)).toBe(false);
      const foreign = await session(OWNER_A, ORG_B);
      expect(foreign.registry.mcp).toEqual([]);
      expect(foreign.rows).toEqual([]);
    });

    it('a foreign endpoint smuggled into the turn is refused before any network call', async () => {
      const b = await session(ADMIN_B, ORG_B);
      const foreignRow = b.pick(EP_B, 'search_docs');
      const db = fakeDb(state, OWNER_A);
      const toolset = buildChatToolset(db, { organizationId: ORG_A, userId: OWNER_A, threadId: THREAD }, [foreignRow], { registry: b.registry, mcp: deps });
      const before = server.toolCalls().length;
      const r = await toolset.execute(call('search_docs', { q: 'x' }));
      expect(r.ok).toBe(false);
      expect(r.code).toBe('CONNECTION_NOT_FOUND');
      expect(server.toolCalls().length).toBe(before);
    });
  });

  describe('execution', () => {
    it('runs a read tool through the egress proxy against the real MCP server', async () => {
      const { pick, toolset } = await session(OWNER_A);
      const ts = toolset([pick(EP_A, 'search_docs')]);
      expect(ts.specs.map((s) => s.name)).toEqual(['search_docs']);
      const connectsBefore = proxy.connects.length;
      const r = await ts.execute(call('search_docs', { q: 'vpn' }, 'c-read'));
      expect(r).toEqual({ ok: true, content: JSON.stringify({ ok: true, data: { content: 'search_docs:{"q":"vpn"}' } }) });
      const last = server.toolCalls().at(-1)!;
      expect(last.params).toEqual({ name: 'search_docs', arguments: { q: 'vpn' } });
      // The session id comes from the Mcp-Session-Id header of THIS call's initialize, and the server accepted it.
      expect(last.sessionId).toBe(server.sessions.at(-1));
      expect(last.status).toBe(200);
      expect(last.authorization).toBeNull();
      expect(proxy.connects.length).toBeGreaterThan(connectsBefore);
      expect(proxy.connects.slice(connectsBefore).every((c) => c === `${MCP_HOST}:443`)).toBe(true);
      expect(audits.map((a) => [a.capability, a.outcome, a.endpointId, a.connectionId])).toEqual([['external.search_docs', 'ok', EP_A, EP_A]]);
      expect(state.rpcLog.some((x) => x.fn === 'claim_tool_approval')).toBe(false);
    });

    it('accepts SSE-framed replies (Streamable HTTP)', async () => {
      server.mode = 'sse';
      const { pick, toolset } = await session(OWNER_A);
      expect((await toolset([pick(EP_A, 'search_docs')]).execute(call('search_docs', { q: 'a' }))).ok).toBe(true);
    });

    it('refuses a write tool without an approval and never contacts the server', async () => {
      const { pick, toolset } = await session(OWNER_A);
      const before = server.toolCalls().length;
      const r = await toolset([pick(EP_A, 'create_ticket')]).execute(call('create_ticket', { q: 'new' }));
      expect(r.code).toBe('APPROVAL_REQUIRED');
      expect(server.toolCalls().length).toBe(before);
      expect(state.rpcLog.find((x) => x.fn === 'claim_tool_approval')?.args).toEqual({
        p_organization_id: ORG_A, p_connection_id: EP_A, p_capability: 'external.create_ticket', p_arguments_sha256: sha({ q: 'new' }), p_thread_id: THREAD,
      });
    });

    it('a single-use approval runs the exact call once; a reuse is refused', async () => {
      approve(state, { requested_by: OWNER_A, thread_id: THREAD,  organization_id: ORG_A, connection_id: EP_A, capability: 'external.create_ticket', arguments_sha256: sha({ q: 'new' }), expires_at: Date.now() + 60_000 });
      const { pick, toolset } = await session(OWNER_A);
      const ts = toolset([pick(EP_A, 'create_ticket')]);
      const before = server.toolCalls().length;
      expect((await ts.execute(call('create_ticket', { q: 'new' }))).ok).toBe(true);
      expect((await ts.execute(call('create_ticket', { q: 'new' }))).code).toBe('APPROVAL_REQUIRED');
      expect(server.toolCalls().length).toBe(before + 1);
      expect(state.approvals[0].used_at).not.toBeNull();
    });

    it('an approval for other arguments, an expired or a revoked approval is refused', async () => {
      approve(state, { requested_by: OWNER_A, thread_id: THREAD,  organization_id: ORG_A, connection_id: EP_A, capability: 'external.create_ticket', arguments_sha256: sha({ q: 'other' }), expires_at: Date.now() + 60_000 });
      approve(state, { requested_by: OWNER_A, thread_id: THREAD,  organization_id: ORG_A, connection_id: EP_A, capability: 'external.create_ticket', arguments_sha256: sha({ q: 'old' }), expires_at: Date.now() - 1 });
      const revoked = approve(state, { requested_by: OWNER_A, thread_id: THREAD,  organization_id: ORG_A, connection_id: EP_A, capability: 'external.create_ticket', arguments_sha256: sha({ q: 'rev' }), expires_at: Date.now() + 60_000 });
      revoked.revoked_at = Date.now();
      const { pick, toolset } = await session(OWNER_A);
      const ts = toolset([pick(EP_A, 'create_ticket')]);
      const before = server.toolCalls().length;
      for (const q of ['new', 'old', 'rev']) expect((await ts.execute(call('create_ticket', { q }))).code).toBe('APPROVAL_REQUIRED');
      expect(server.toolCalls().length).toBe(before);
    });

    it('an approval for another organization or endpoint does not count', async () => {
      approve(state, { requested_by: OWNER_A, thread_id: THREAD,  organization_id: ORG_B, connection_id: EP_A, capability: 'external.create_ticket', arguments_sha256: sha({ q: 'new' }), expires_at: Date.now() + 60_000 });
      approve(state, { requested_by: OWNER_A, thread_id: THREAD,  organization_id: ORG_A, connection_id: EP_A_SECOND, capability: 'external.create_ticket', arguments_sha256: sha({ q: 'new' }), expires_at: Date.now() + 60_000 });
      const { pick, toolset } = await session(OWNER_A);
      expect((await toolset([pick(EP_A, 'create_ticket')]).execute(call('create_ticket', { q: 'new' }))).code).toBe('APPROVAL_REQUIRED');
    });

    it('irreversible tools also need a claim (stored class decides, not the tool name)', async () => {
      const { pick, toolset } = await session(OWNER_A);
      const ts = toolset([pick(EP_A, 'delete_project')]);
      expect((await ts.execute(call('delete_project', { q: 'p1' }))).code).toBe('APPROVAL_REQUIRED');
      approve(state, { requested_by: OWNER_A, thread_id: THREAD,  organization_id: ORG_A, connection_id: EP_A, capability: 'external.delete_project', arguments_sha256: sha({ q: 'p1' }), expires_at: Date.now() + 60_000 });
      expect((await ts.execute(call('delete_project', { q: 'p1' }))).ok).toBe(true);
    });

    it('stops the next call when the endpoint is turned off or the snapshot revoked mid-turn', async () => {
      const { pick, toolset } = await session(OWNER_A);
      const ts = toolset([pick(EP_A, 'search_docs')]);
      const before = server.toolCalls().length;
      state.endpoints.find((e) => e.id === EP_A)!.status = 'disabled';
      expect((await ts.execute(call('search_docs', { q: 'a' }))).ok).toBe(false);
      state.endpoints.find((e) => e.id === EP_A)!.status = 'active';
      state.snapshots.find((s) => s.id === 's-a1')!.revoked_at = '2026-11-16T00:00:00Z';
      expect((await ts.execute(call('search_docs', { q: 'b' }))).ok).toBe(false);
      expect(server.toolCalls().length).toBe(before);
    });

    it('fails closed when the proxy is down or refuses', async () => {
      const port = await deadPort();
      const down = { ...deps, fetchFn: createEgressMcpFetch({ proxyUrl: `http://127.0.0.1:${port}`, ca: tlsMaterial.cert }) };
      const s1 = await session(OWNER_A, ORG_A, down);
      expect((await s1.toolset([s1.pick(EP_A, 'search_docs')]).execute(call('search_docs', { q: 'a' }))).code).toBe('PROVIDER_UNAVAILABLE');
      proxy.refuse = true;
      const s2 = await session(OWNER_A);
      const before = server.toolCalls().length;
      expect((await s2.toolset([s2.pick(EP_A, 'search_docs')]).execute(call('search_docs', { q: 'a' }))).code).toBe('PROVIDER_UNAVAILABLE');
      expect(server.toolCalls().length).toBe(before);
    });

    it('the SSRF floor still applies: a private address is refused before the proxy', async () => {
      const s = await session(OWNER_A, ORG_A, { ...deps, resolveHostname: async () => ['10.0.0.5'] });
      const before = proxy.connects.length;
      expect((await s.toolset([s.pick(EP_A, 'search_docs')]).execute(call('search_docs', { q: 'a' }))).code).toBe('PROVIDER_UNAVAILABLE');
      expect(proxy.connects.length).toBe(before);
    });

    it('maps a tool-reported error to TOOL_ERROR, and JSON-RPC / HTTP errors to PROVIDER_UNAVAILABLE', async () => {
      const { pick, toolset } = await session(OWNER_A);
      const ts = toolset([pick(EP_A, 'search_docs')]);
      server.onTool = () => ({ text: 'nope', isError: true });
      const toolErr = await ts.execute(call('search_docs', { q: '1' }));
      expect(toolErr.code).toBe('TOOL_ERROR');
      expect(toolErr.content).not.toContain('nope'); // the tool's own text is untrusted and never reaches the model
      server.onTool = () => ({ rpcError: 'bad' });
      expect((await ts.execute(call('search_docs', { q: '2' }))).code).toBe('PROVIDER_UNAVAILABLE');
      server.mode = 'http500';
      expect((await ts.execute(call('search_docs', { q: '3' }))).code).toBe('PROVIDER_UNAVAILABLE');
      expect(audits.map((a) => a.outcome)).toEqual(['TOOL_ERROR', 'PROVIDER_UNAVAILABLE', 'PROVIDER_UNAVAILABLE']);
    });

    it('withholds the result when the audit record cannot be written', async () => {
      auditFails = true;
      server.onTool = () => ({ text: 'secret-result' });
      const { pick, toolset } = await session(OWNER_A);
      const r = await toolset([pick(EP_A, 'search_docs')]).execute(call('search_docs', { q: 'a' }));
      expect(r.ok).toBe(false);
      expect(r.code).toBe('INTERNAL');
      expect(r.content).not.toContain('secret-result');
    });
  });

  describe('MCP session contract over real sockets (spec 2025-06-18 session management)', () => {
    /** The requests one execute made: from its initialize to the end of the log. */
    const lastSession = () => server.calls.slice(server.calls.map((c) => c.method).lastIndexOf('initialize'));

    it('the session id comes only from the Mcp-Session-Id header and is sent on every later message', async () => {
      const { pick, toolset } = await session(OWNER_A);
      const r = await toolset([pick(EP_A, 'search_docs')]).execute(call('search_docs', { q: 'h' }));
      expect(r.ok).toBe(true);
      const msgs = lastSession();
      expect(msgs.map((c) => c.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
      expect(msgs[0].sessionId).toBeNull();
      expect(msgs.slice(1).every((c) => c.sessionId === server.sessions.at(-1))).toBe(true);
      expect(msgs.map((c) => c.status)).toEqual([200, 202, 200]);
    });

    it('the initialized notification carries no id; requests carry numeric ids', async () => {
      const { pick, toolset } = await session(OWNER_A);
      await toolset([pick(EP_A, 'search_docs')]).execute(call('search_docs', { q: 'n' }));
      const [init, note, tool] = lastSession();
      expect(note.hasId).toBe(false);
      expect([init.hasId, typeof init.id, tool.hasId, typeof tool.id]).toEqual([true, 'number', true, 'number']);
    });

    it('every execute opens its own session', async () => {
      const { pick, toolset } = await session(OWNER_A);
      const ts = toolset([pick(EP_A, 'search_docs')]);
      const n = server.sessions.length;
      await ts.execute(call('search_docs', { q: '1' }));
      await ts.execute(call('search_docs', { q: '2' }));
      expect(server.sessions.length).toBe(n + 2);
      const calls = server.toolCalls().slice(-2);
      expect(calls[0].sessionId).not.toBe(calls[1].sessionId);
    });

    it('a stateless server (no Mcp-Session-Id) works and receives no session header', async () => {
      server.sessionMode = 'stateless';
      const { pick, toolset } = await session(OWNER_A);
      const r = await toolset([pick(EP_A, 'search_docs')]).execute(call('search_docs', { q: 's' }));
      expect(r).toEqual({ ok: true, content: JSON.stringify({ ok: true, data: { content: 'search_docs:{"q":"s"}' } }) });
      expect(lastSession().every((c) => c.sessionId === null)).toBe(true);
    });

    it('a failed initialized notification aborts before tools/call and is audited as unavailable', async () => {
      server.mode = 'notify500';
      const { pick, toolset } = await session(OWNER_A);
      const before = server.toolCalls().length;
      const r = await toolset([pick(EP_A, 'search_docs')]).execute(call('search_docs', { q: 'x' }));
      expect(r.code).toBe('PROVIDER_UNAVAILABLE');
      expect(server.toolCalls().length).toBe(before);
      expect(audits.map((a) => a.outcome)).toEqual(['PROVIDER_UNAVAILABLE']);
    });

    it.each(['wrongId', 'noJsonrpc'] as const)('a %s reply is not returned to the model', async (mode) => {
      server.mode = mode;
      server.onTool = () => ({ text: 'must-not-leak' });
      const { pick, toolset } = await session(OWNER_A);
      const r = await toolset([pick(EP_A, 'search_docs')]).execute(call('search_docs', { q: 'x' }));
      expect(r.code).toBe('PROVIDER_UNAVAILABLE');
      expect(r.content).not.toContain('must-not-leak');
    });

    it('snapshot discovery uses the same contract through the real egress proxy', async () => {
      const connects = proxy.connects.length;
      const tools = await listExternalMcpTools({ url: URL_A, resolveHostname }, createEgressMcpFetch({ proxyUrl: proxy.url, ca: tlsMaterial.cert }));
      expect(tools.map((t) => t.name)).toEqual(['search_docs', 'create_ticket']);
      const msgs = lastSession();
      expect(msgs.map((c) => [c.method, c.status])).toEqual([['initialize', 200], ['notifications/initialized', 202], ['tools/list', 200]]);
      expect(msgs.slice(1).every((c) => c.sessionId === server.sessions.at(-1))).toBe(true);
      expect(msgs[1].hasId).toBe(false);
      expect(proxy.connects.slice(connects).every((c) => c === `${MCP_HOST}:443`)).toBe(true);
    });
  });

  describe('M6: multi-call turns, call ids, session continuity, size caps, call budget, protocol', () => {
    type Asst = Extract<WireMessage, { role: 'assistant' }>;
    /** Runs a full turn through the REAL toolset; the model's rounds are scripted (labelled fake model). */
    async function turnWith(attached: CapabilityRow[], rounds: { id: string; name: string; arguments: Record<string, unknown> }[][]) {
      const { toolset } = await session(OWNER_A);
      const ts = toolset(attached);
      let r = 0; let final: WireMessage[] = [];
      const events: TurnEvent[] = [];
      const gen = runTurn({ messages: [{ role: 'user', content: 'go' }], tools: ts.specs, maxToolRounds: rounds.length + 1 }, {
        async completeWithTools() { return { text: null, toolCalls: rounds[r++] ?? [] }; },
        executeTool: (c) => ts.execute(c),
        async *stream(m) { final = [...m]; yield 'done'; },
      });
      for (;;) { const n = await gen.next(); if (n.done) break; events.push(n.value); }
      return { final, events };
    }
    function pairs(final: WireMessage[]) {
      let pending: NonNullable<Asst['tool_calls']> = [];
      const out: { id: string; name: string; args: Record<string, unknown>; content: string }[] = [];
      for (const m of final) {
        if (m.role === 'assistant' && m.tool_calls) pending = [...m.tool_calls];
        if (m.role === 'tool') {
          const tc = pending.find((t) => t.id === m.tool_call_id);
          out.push({ id: m.tool_call_id, name: tc?.function.name ?? '<unpaired>', args: tc ? JSON.parse(tc.function.arguments) : null, content: m.content });
        }
      }
      return out;
    }

    it('a turn with several calls and DUPLICATE model ids: each call runs once in its own session, results pair with the right call, a write without approval never reaches the server', async () => {
      const { pick } = await session(OWNER_A);
      const toolCallsBefore = server.toolCalls().length;
      const callsBefore = server.calls.length;
      const { final, events } = await turnWith([pick(EP_A, 'search_docs'), pick(EP_A, 'create_ticket')], [[
        { id: 'dup', name: 'search_docs', arguments: { q: 'one' } },
        { id: 'dup', name: 'search_docs', arguments: { q: 'two' } },
        { id: 'dup', name: 'create_ticket', arguments: { q: 'needs-approval' } },
      ]]);
      const p = pairs(final);
      expect(new Set(p.map((x) => x.id)).size).toBe(3);
      expect(p.map((x) => x.name)).toEqual(['search_docs', 'search_docs', 'create_ticket']);
      expect(JSON.parse(p[0].content)).toEqual({ ok: true, data: { content: 'search_docs:{"q":"one"}' } });
      expect(JSON.parse(p[1].content)).toEqual({ ok: true, data: { content: 'search_docs:{"q":"two"}' } });
      expect(p[0].args).toEqual({ q: 'one' }); expect(p[1].args).toEqual({ q: 'two' });
      expect(JSON.parse(p[2].content)).toMatchObject({ ok: false, error: 'APPROVAL_REQUIRED' });
      // Order on the wire: assistant(tool_calls), then one tool message per call in the same order.
      expect(final.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'tool']);
      // The server saw exactly the two reads; the write never left the runtime.
      const tc = server.toolCalls().slice(toolCallsBefore);
      expect(tc.map((c) => c.params)).toEqual([{ name: 'search_docs', arguments: { q: 'one' } }, { name: 'search_docs', arguments: { q: 'two' } }]);
      // Session continuity: each call is initialize -> initialized -> tools/call under ONE session id, distinct per call.
      const wire = server.calls.slice(callsBefore);
      expect(wire.map((c) => c.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call', 'initialize', 'notifications/initialized', 'tools/call']);
      expect([wire[1].sessionId, wire[2].sessionId]).toEqual([tc[0].sessionId, tc[0].sessionId]);
      expect([wire[4].sessionId, wire[5].sessionId]).toEqual([tc[1].sessionId, tc[1].sessionId]);
      expect(tc[0].sessionId).not.toBe(tc[1].sessionId);
      expect(server.sessions).toEqual(expect.arrayContaining([tc[0].sessionId, tc[1].sessionId]));
      // Events carry the same unique ids, and audits one row per call.
      expect(events.filter((e) => e.type === 'tool_result').map((e) => (e as { callId: string }).callId)).toEqual(p.map((x) => x.id));
      expect(audits.map((a) => [a.capability, a.outcome])).toEqual([['external.search_docs', 'ok'], ['external.search_docs', 'ok'], ['external.create_ticket', 'APPROVAL_REQUIRED']]);
    });

    it('MCP-Protocol-Version: the real server receives the negotiated version on every message after initialize', async () => {
      const { pick, toolset } = await session(OWNER_A);
      const before = server.calls.length;
      expect((await toolset([pick(EP_A, 'search_docs')]).execute(call('search_docs', { q: 'v' }))).ok).toBe(true);
      expect(server.calls.slice(before).map((c) => [c.method, c.protocolVersion])).toEqual([
        ['initialize', null], ['notifications/initialized', '2025-06-18'], ['tools/call', '2025-06-18'],
      ]);
    });

    it('an unsupported negotiated protocol version aborts before tools/call (audited, nothing returned)', async () => {
      server.mode = 'badVersion';
      server.onTool = () => ({ text: 'must-not-run' });
      const { pick, toolset } = await session(OWNER_A);
      const before = server.calls.length;
      const r = await toolset([pick(EP_A, 'search_docs')]).execute(call('search_docs', { q: 'v' }));
      expect(r.code).toBe('PROVIDER_UNAVAILABLE');
      expect(server.calls.slice(before).map((c) => c.method)).toEqual(['initialize']);
      expect(audits.map((a) => a.outcome)).toEqual(['PROVIDER_UNAVAILABLE']);
    });

    it('a server->client request reusing our id (SSE) does not replace the real response', async () => {
      server.mode = 'collide';
      const { pick, toolset } = await session(OWNER_A);
      const r = await toolset([pick(EP_A, 'search_docs')]).execute(call('search_docs', { q: 'c' }));
      expect(r).toEqual({ ok: true, content: JSON.stringify({ ok: true, data: { content: 'search_docs:{"q":"c"}' } }) });
    });

    it.each([
      ['9 KiB (over the runtime 8 KiB model cap)', 9 * 1024],
      ['100 KiB (over the adapter 64 KiB result cap)', 100 * 1024],
    ])('an oversized tool result, %s, is OUTPUT_TOO_LARGE: audited, nothing of it reaches the model', async (_l, size) => {
      server.onTool = () => ({ text: 'Q'.repeat(size) });
      const { pick, toolset } = await session(OWNER_A);
      const r = await toolset([pick(EP_A, 'search_docs')]).execute(call('search_docs', { q: 'big' }));
      expect(r.ok).toBe(false);
      expect(r.code).toBe('OUTPUT_TOO_LARGE');
      expect(r.content).not.toContain('QQQQ');
      expect(Buffer.byteLength(r.content)).toBeLessThan(1024);
      expect(audits.map((a) => a.outcome)).toEqual(['OUTPUT_TOO_LARGE']);
    });

    it('a 2 MiB reply is cut at the egress transport cap and fails closed', async () => {
      server.mode = 'huge';
      const { pick, toolset } = await session(OWNER_A);
      const r = await toolset([pick(EP_A, 'search_docs')]).execute(call('search_docs', { q: 'huge' }));
      expect(r.ok).toBe(false);
      expect(r.content).not.toContain('xxxx');
      expect(Buffer.byteLength(r.content)).toBeLessThan(1024);
    });

    it('the per-turn call budget (4) applies to one-at-a-time chat calls: the 5th is refused, audited, and never sent', async () => {
      const { pick, toolset } = await session(OWNER_A);
      const ts = toolset([pick(EP_A, 'search_docs')]);
      const before = server.toolCalls().length;
      const rs = [];
      for (let i = 1; i <= 5; i++) rs.push(await ts.execute(call('search_docs', { q: `n${i}` }, `b${i}`)));
      expect(rs.map((r) => r.code ?? 'ok')).toEqual(['ok', 'ok', 'ok', 'ok', 'CALL_BUDGET_EXCEEDED']);
      expect(server.toolCalls().length - before).toBe(4);
      expect(audits.map((a) => a.outcome)).toEqual(['ok', 'ok', 'ok', 'ok', 'CALL_BUDGET_EXCEEDED']);
    });
  });

  describe('streaming events', () => {
    it('emits tool_start / tool_result with the server-side provider label, then the answer', async () => {
      approve(state, { requested_by: OWNER_A, thread_id: THREAD,  organization_id: ORG_A, connection_id: EP_A, capability: 'external.create_ticket', arguments_sha256: sha({ q: 'ok' }), expires_at: Date.now() + 60_000 });
      const { pick, toolset } = await session(OWNER_A);
      const ts = toolset([pick(EP_A, 'search_docs'), pick(EP_A, 'create_ticket')]);
      const toolMessages: string[] = [];
      let round = 0;
      const events: TurnEvent[] = [];
      const gen = runTurn({ messages: [{ role: 'user', content: 'go' }], tools: ts.specs }, {
        async completeWithTools(messages) {
          round += 1;
          if (round === 1) {
            return { text: null, toolCalls: [
              { id: 't1', name: 'search_docs', arguments: { q: 'vpn' } },
              { id: 't2', name: 'create_ticket', arguments: { q: 'unapproved' } },
              { id: 't3', name: 'create_ticket', arguments: { q: 'ok' } },
            ] };
          }
          for (const m of messages) if (m.role === 'tool') toolMessages.push(m.content);
          return { text: 'Done.', toolCalls: [] };
        },
        stream: async function* () { yield 'unused'; },
        executeTool: (c) => ts.execute(c),
      });
      for (;;) { const n = await gen.next(); if (n.done) break; events.push(n.value); }
      expect(events).toEqual([
        { type: 'tool_start', tool: 'search_docs', callId: 't1' }, { type: 'tool_result', tool: 'search_docs', callId: 't1', ok: true },
        { type: 'tool_start', tool: 'create_ticket', callId: 't2' }, { type: 'tool_result', tool: 'create_ticket', callId: 't2', ok: false, code: 'APPROVAL_REQUIRED' },
        { type: 'tool_start', tool: 'create_ticket', callId: 't3' }, { type: 'tool_result', tool: 'create_ticket', callId: 't3', ok: true },
        { type: 'delta', text: 'Done.' },
      ]);
      // What the messages route adds to each tool event, and what the UI renders from it.
      const d = ts.describe('search_docs');
      expect(d).toEqual({ capabilityKey: 'external.search_docs', providerName: 'Acme Docs MCP', providerKey: 'mcp' });
      expect(toolLabel('search_docs', d?.providerName)).toBe('Using search_docs in Acme Docs MCP');
      expect(toolProblem('APPROVAL_REQUIRED').text.length).toBeGreaterThan(0);
      expect(toolMessages[0]).toContain('search_docs:{\\"q\\":\\"vpn\\"}');
      expect(JSON.parse(toolMessages[1])).toMatchObject({ ok: false, error: 'APPROVAL_REQUIRED' });
      expect(server.toolCalls().slice(-2).map((c) => (c.params as { arguments: unknown }).arguments)).toEqual([{ q: 'vpn' }, { q: 'ok' }]);
    });
  });

  describe('chat approvals (B-11)', () => {
    it('describes a write tool for the approval card from server rows: endpoint, host only, tool, stored class', async () => {
      const { pick, toolset } = await session(OWNER_A);
      const ts = toolset([pick(EP_A, 'create_ticket'), pick(EP_A, 'search_docs')]);
      expect(ts.approvalTarget('create_ticket')).toEqual({
        endpointId: EP_A, endpointName: 'Acme Docs MCP', endpointHost: MCP_HOST,
        capability: 'external.create_ticket', toolName: 'create_ticket', toolDescription: expect.any(String), permissionClass: 'write',
      });
      expect(ts.approvalTarget('search_docs')).toBeNull(); // read tools never need a card
      expect(ts.approvalTarget('nope')).toBeNull();
    });
    it('the card hash is exactly what the runtime claims and audits; an approval for it runs once', async () => {
      const args = { title: 'VPN broken', tags: ['it', 'urgent'], meta: { b: 2, a: 1 } };
      const { pick, toolset } = await session(OWNER_A);
      const ts = toolset([pick(EP_A, 'create_ticket')]);
      expect((await ts.execute(call('create_ticket', args))).code).toBe('APPROVAL_REQUIRED');
      const denied = audits.at(-1)!;
      expect(denied.outcome).toBe('APPROVAL_REQUIRED');
      expect(argumentsSha256(args)).toBe(denied.argumentsSha256);
      expect(argumentsSha256({ meta: { a: 1, b: 2 }, tags: ['it', 'urgent'], title: 'VPN broken' })).toBe(denied.argumentsSha256);
      approve(state, { requested_by: OWNER_A, thread_id: THREAD,  organization_id: ORG_A, connection_id: EP_A, capability: 'external.create_ticket', arguments_sha256: argumentsSha256(args), expires_at: Date.now() + 60_000 });
      expect((await fakeDb(state, OWNER_A).rpc('is_tool_approved', { p_organization_id: ORG_A, p_connection_id: EP_A, p_capability: 'external.create_ticket', p_arguments_sha256: argumentsSha256(args), p_thread_id: THREAD })).data).toBe(true);
      expect((await ts.execute(call('create_ticket', args))).ok).toBe(true);
      expect((await ts.execute(call('create_ticket', args))).code).toBe('APPROVAL_REQUIRED');
      expect((await ts.execute(call('create_ticket', { ...args, title: 'changed' }))).code).toBe('APPROVAL_REQUIRED');
    });
    it('F-4: another user cannot claim an approval', async () => {
      const args = { q: 'x' };
      approve(state, { requested_by: OWNER_A, thread_id: THREAD, organization_id: ORG_A, connection_id: EP_A, capability: 'external.create_ticket', arguments_sha256: argumentsSha256(args), expires_at: Date.now() + 60_000 });
      expect((await fakeDb(state, MEMBER_A).rpc('claim_tool_approval', { p_organization_id: ORG_A, p_connection_id: EP_A, p_capability: 'external.create_ticket', p_arguments_sha256: argumentsSha256(args), p_thread_id: THREAD })).data).toBe(false);
    });
    it('F-4: another thread cannot reuse an approval', async () => {
      const args = { q: 'y' };
      approve(state, { requested_by: OWNER_A, thread_id: THREAD, organization_id: ORG_A, connection_id: EP_A, capability: 'external.create_ticket', arguments_sha256: argumentsSha256(args), expires_at: Date.now() + 60_000 });
      expect((await fakeDb(state, OWNER_A).rpc('claim_tool_approval', { p_organization_id: ORG_A, p_connection_id: EP_A, p_capability: 'external.create_ticket', p_arguments_sha256: argumentsSha256(args), p_thread_id: 'c0000000-0000-4000-8000-0000000000ff' })).data).toBe(false);
    });
    it('F-4: missing requester/thread cannot pass', async () => {
      const args = { q: 'z' };
      approve(state, { organization_id: ORG_A, connection_id: EP_A, capability: 'external.create_ticket', arguments_sha256: argumentsSha256(args), expires_at: Date.now() + 60_000 });
      expect((await fakeDb(state, OWNER_A).rpc('claim_tool_approval', { p_organization_id: ORG_A, p_connection_id: EP_A, p_capability: 'external.create_ticket', p_arguments_sha256: argumentsSha256(args), p_thread_id: THREAD })).data).toBe(false);
    });
  });

  describe('gate: MCP stays unavailable unless provably runnable', () => {
    it('customer MCP switch off', async () => {
      const { registry, pick } = await session(OWNER_A, ORG_A, { ...deps, env: { CONNECT_EGRESS_PROXY: proxy.url } });
      expect(registry.mcpGate).toEqual({ open: false, reason: 'FEATURE_OFF' });
      expect(toolAvailable(pick(EP_A, 'search_docs'), registry)).toBe(false);
    });
    it('no or invalid egress proxy', async () => {
      for (const env of [{ TUGPT_CUSTOMER_MCP_ENABLED: 'true', TUGPT_CHAT_MCP_EXECUTION_ENABLED: 'true' }, { TUGPT_CUSTOMER_MCP_ENABLED: 'true', TUGPT_CHAT_MCP_EXECUTION_ENABLED: 'true', CONNECT_EGRESS_PROXY: 'https://proxy:443' }]) {
        const { registry } = await session(OWNER_A, ORG_A, { ...deps, env });
        expect(registry.mcpGate).toEqual({ open: false, reason: 'EGRESS_NOT_CONFIGURED' });
        expect(registry.mcp).toEqual([]);
      }
    });
    it('chat execution switch off: the Connect switch alone never runs MCP from chat', async () => {
      const { registry, pick } = await session(OWNER_A, ORG_A, { ...deps, env: { TUGPT_CUSTOMER_MCP_ENABLED: 'true', CONNECT_EGRESS_PROXY: proxy.url } });
      expect(registry.mcpGate).toEqual({ open: false, reason: 'CHAT_EXECUTION_OFF' });
      expect(registry.mcp).toEqual([]);
      expect(mcpUnavailableReason(pick(EP_A, 'search_docs'), registry)).toBe('MCP_CHAT_EXECUTION_OFF');
      for (const v of ['1', 'TRUE', 'yes', ' true']) {
        const r = await loadChatToolRegistry(fakeDb(state, OWNER_A), ORG_A, { ...deps, env: { TUGPT_CUSTOMER_MCP_ENABLED: 'true', TUGPT_CHAT_MCP_EXECUTION_ENABLED: v, CONNECT_EGRESS_PROXY: proxy.url } });
        expect(r.mcpGate).toEqual({ open: false, reason: 'CHAT_EXECUTION_OFF' });
      }
    });
    it('an explicit null audit sink keeps the gate closed', async () => {
      const registry = await loadChatToolRegistry(fakeDb(state, OWNER_A), ORG_A, { ...deps, audit: null });
      expect(registry.mcpGate).toEqual({ open: false, reason: 'AUDIT_UNAVAILABLE' });
      expect(registry.mcp).toEqual([]);
    });
    it('the member client cannot write the MCP audit or resolve endpoints (real EXECUTE grants)', async () => {
      const member = fakeDb(state, OWNER_A);
      const row = { p_organization_id: ORG_A, p_endpoint_id: EP_A, p_actor_user_id: OWNER_A, p_capability: 'external.search_docs', p_outcome: 'ok', p_error_code: null, p_duration_ms: 1, p_arguments_sha256: sha({}) };
      expect((await member.rpc('record_mcp_tool_call', row)).error).toMatchObject({ code: '42501' });
      expect((await member.rpc('resolve_mcp_execution', { p_organization_id: ORG_A, p_endpoint_id: EP_A })).error).toMatchObject({ code: '42501' });
      expect((await fakeTrustedDb(state).rpc('record_mcp_tool_call', { ...row, p_actor_user_id: ADMIN_B })).error).toMatchObject({ code: '42501' });
    });
    it('without a trusted client the default audit sink is absent and the gate stays closed', async () => {
      const { audit: _unused, ...withoutAudit } = deps;
      void _unused;
      const registry = await loadChatToolRegistry(fakeDb(state, OWNER_A), ORG_A, withoutAudit);
      expect(registry.mcpGate).toEqual({ open: false, reason: 'AUDIT_UNAVAILABLE' });
      expect(registry.mcp).toEqual([]);
    });
    it('production default wires Agent 2\'s record_mcp_tool_call sink on the trusted sso_control client', async () => {
      const { audit: _unused, ...withoutAudit } = deps;
      void _unused;
      const s = await session(OWNER_A, ORG_A, withoutAudit);
      expect(s.registry.mcpGate).toEqual({ open: true });
      const r = await s.toolset([s.pick(EP_A, 'search_docs')]).execute(call('search_docs', { q: 'audit' }));
      expect(r.ok).toBe(true);
      expect(state.mcpAudit).toEqual([expect.objectContaining({
        p_organization_id: ORG_A, p_endpoint_id: EP_A, p_capability: 'external.search_docs', p_outcome: 'ok', p_arguments_sha256: sha({ q: 'audit' }), actor: OWNER_A,
      })]);
    });
    it('picker reasons: not runnable endpoints and non-MCP rows', async () => {
      const { registry, rows } = await session(OWNER_A);
      const pending = rows.find((r) => r.connectionId === EP_A_PENDING);
      if (pending) expect(mcpUnavailableReason(pending, registry)).toBe('MCP_NOT_RUNNABLE');
      expect(mcpUnavailableReason({ providerKey: 'google', capabilityKey: 'calendar.find_availability', connectionId: null, permissionClass: 'read' }, registry)).toBeNull();
      expect(mcpUnavailableReason(rows.find((r) => r.connectionId === EP_A && r.capabilityKey === 'external.search_docs')!, registry)).toBeNull();
    });
    it('database read errors mean no MCP tools', async () => {
      const db = fakeDb(state, OWNER_A);
      db.failTables.add('external_tool_snapshots');
      const registry = await loadChatToolRegistry(db, ORG_A, deps);
      expect(registry.mcp).toEqual([]);
    });
  });
});
