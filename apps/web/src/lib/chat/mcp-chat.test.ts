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
import { createEgressMcpFetch } from './mcp-egress';
import { loadChatToolRegistry, mcpUnavailableReason, type McpAuditSink, type McpDeps } from './mcp';
import { argumentsSha256 } from './approval.server';
import { canonicalJson, runTurn, type TurnEvent } from './turn';
import { listCapabilities, type CapabilityRow } from './store';
import { toolLabel, toolProblem } from '../connect-ui/chat-errors';
import {
  approve, deadPort, emptyState, fakeDb, makeCertificate, MCP_HOST, opensslAvailable, startConnectProxy, startMcpServer,
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
    const registry = await loadChatToolRegistry(db, org, { ...d, serviceDb: db as never });
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
      expect(last.sessionId).toBe('sess-1');
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
        p_organization_id: ORG_A, p_connection_id: EP_A, p_capability: 'external.create_ticket', p_arguments_sha256: sha({ q: 'new' }),
      });
    });

    it('a single-use approval runs the exact call once; a reuse is refused', async () => {
      approve(state, { organization_id: ORG_A, connection_id: EP_A, capability: 'external.create_ticket', arguments_sha256: sha({ q: 'new' }), expires_at: Date.now() + 60_000 });
      const { pick, toolset } = await session(OWNER_A);
      const ts = toolset([pick(EP_A, 'create_ticket')]);
      const before = server.toolCalls().length;
      expect((await ts.execute(call('create_ticket', { q: 'new' }))).ok).toBe(true);
      expect((await ts.execute(call('create_ticket', { q: 'new' }))).code).toBe('APPROVAL_REQUIRED');
      expect(server.toolCalls().length).toBe(before + 1);
      expect(state.approvals[0].used_at).not.toBeNull();
    });

    it('an approval for other arguments, an expired or a revoked approval is refused', async () => {
      approve(state, { organization_id: ORG_A, connection_id: EP_A, capability: 'external.create_ticket', arguments_sha256: sha({ q: 'other' }), expires_at: Date.now() + 60_000 });
      approve(state, { organization_id: ORG_A, connection_id: EP_A, capability: 'external.create_ticket', arguments_sha256: sha({ q: 'old' }), expires_at: Date.now() - 1 });
      const revoked = approve(state, { organization_id: ORG_A, connection_id: EP_A, capability: 'external.create_ticket', arguments_sha256: sha({ q: 'rev' }), expires_at: Date.now() + 60_000 });
      revoked.revoked_at = Date.now();
      const { pick, toolset } = await session(OWNER_A);
      const ts = toolset([pick(EP_A, 'create_ticket')]);
      const before = server.toolCalls().length;
      for (const q of ['new', 'old', 'rev']) expect((await ts.execute(call('create_ticket', { q }))).code).toBe('APPROVAL_REQUIRED');
      expect(server.toolCalls().length).toBe(before);
    });

    it('an approval for another organization or endpoint does not count', async () => {
      approve(state, { organization_id: ORG_B, connection_id: EP_A, capability: 'external.create_ticket', arguments_sha256: sha({ q: 'new' }), expires_at: Date.now() + 60_000 });
      approve(state, { organization_id: ORG_A, connection_id: EP_A_SECOND, capability: 'external.create_ticket', arguments_sha256: sha({ q: 'new' }), expires_at: Date.now() + 60_000 });
      const { pick, toolset } = await session(OWNER_A);
      expect((await toolset([pick(EP_A, 'create_ticket')]).execute(call('create_ticket', { q: 'new' }))).code).toBe('APPROVAL_REQUIRED');
    });

    it('irreversible tools also need a claim (stored class decides, not the tool name)', async () => {
      const { pick, toolset } = await session(OWNER_A);
      const ts = toolset([pick(EP_A, 'delete_project')]);
      expect((await ts.execute(call('delete_project', { q: 'p1' }))).code).toBe('APPROVAL_REQUIRED');
      approve(state, { organization_id: ORG_A, connection_id: EP_A, capability: 'external.delete_project', arguments_sha256: sha({ q: 'p1' }), expires_at: Date.now() + 60_000 });
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

    it('maps tool errors, JSON-RPC errors and HTTP errors to PROVIDER_UNAVAILABLE', async () => {
      const { pick, toolset } = await session(OWNER_A);
      const ts = toolset([pick(EP_A, 'search_docs')]);
      server.onTool = () => ({ text: 'nope', isError: true });
      expect((await ts.execute(call('search_docs', { q: '1' }))).code).toBe('PROVIDER_UNAVAILABLE');
      server.onTool = () => ({ rpcError: 'bad' });
      expect((await ts.execute(call('search_docs', { q: '2' }))).code).toBe('PROVIDER_UNAVAILABLE');
      server.mode = 'http500';
      expect((await ts.execute(call('search_docs', { q: '3' }))).code).toBe('PROVIDER_UNAVAILABLE');
      expect(audits.map((a) => a.outcome)).toEqual(['PROVIDER_UNAVAILABLE', 'PROVIDER_UNAVAILABLE', 'PROVIDER_UNAVAILABLE']);
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

  describe('streaming events', () => {
    it('emits tool_start / tool_result with the server-side provider label, then the answer', async () => {
      approve(state, { organization_id: ORG_A, connection_id: EP_A, capability: 'external.create_ticket', arguments_sha256: sha({ q: 'ok' }), expires_at: Date.now() + 60_000 });
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
      approve(state, { organization_id: ORG_A, connection_id: EP_A, capability: 'external.create_ticket', arguments_sha256: argumentsSha256(args), expires_at: Date.now() + 60_000 });
      expect((await fakeDb(state, OWNER_A).rpc('is_tool_approved', { p_organization_id: ORG_A, p_connection_id: EP_A, p_capability: 'external.create_ticket', p_arguments_sha256: argumentsSha256(args) })).data).toBe(true);
      expect((await ts.execute(call('create_ticket', args))).ok).toBe(true);
      expect((await ts.execute(call('create_ticket', args))).code).toBe('APPROVAL_REQUIRED');
      expect((await ts.execute(call('create_ticket', { ...args, title: 'changed' }))).code).toBe('APPROVAL_REQUIRED');
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
    it('production default wires Agent 2\'s record_mcp_tool_call sink on the caller\'s client', async () => {
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
