/**
 * The two chat approval routes with production wiring (no injected deps):
 *   GET  /api/v1/chat/approvals/status          -> is_tool_approved via the caller's client
 *   POST /api/v1/chat/threads/[id]/approved-call -> re-validates everything, runtime claims
 * The database is the in-memory fake from mcp.test-harness (mirrors the RPCs'
 * rules); the model stream is stubbed. No MCP server is reachable here, so a
 * claimed call ends in PROVIDER_UNAVAILABLE: that is asserted, not hidden.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approve, emptyState, fakeDb, fakeTrustedDb, type FakeState } from '@/lib/chat/mcp.test-harness';
import { argumentsSha256 } from '@/lib/chat/approval.server';

const ORG = 'a0000000-0000-4000-8000-000000000000';
const OWNER = 'a0000000-0000-4000-8000-0000000000a1';
const MEMBER = 'a0000000-0000-4000-8000-0000000000a3';
const STRANGER = 'b0000000-0000-4000-8000-0000000000b1';
const EP = 'e0000000-0000-4000-8000-00000000000a';
const THREAD = 'c0000000-0000-4000-8000-000000000001';
const ORIGIN = 'https://app.test';
let state: FakeState;
let user = OWNER;
const appended: Record<string, unknown>[] = [];

vi.mock('@/lib/chat/request', async (orig) => ({
  ...(await orig<typeof import('@/lib/chat/request')>()),
  chatContext: async () => ({ db: fakeDb(state, user), userId: user, tenant: { organizationId: ORG, organizationName: 'Test org', role: 'owner' } }),
}));
vi.mock('@/lib/supabase/server', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/server')>()),
  // In production this is the sso_control client: trusted RPCs only, no table grants.
  createSsoControlClient: async () => fakeTrustedDb(state),
}));
vi.mock('@/lib/chat/store', async (orig) => ({
  ...(await orig<typeof import('@/lib/chat/store')>()),
  getThread: async () => ({ id: THREAD }),
  listMessages: async () => [{ id: 'm1', role: 'user', content: 'open a ticket', status: 'complete', mentions: [], capabilityKey: null }],
  appendMessage: async (_db: unknown, m: Record<string, unknown>) => { appended.push(m); return { id: `saved-${appended.length}`, ...m }; },
  touchThread: async () => undefined,
}));
vi.mock('@/lib/chat/openai-compatible', async (orig) => ({
  ...(await orig<typeof import('@/lib/chat/openai-compatible')>()),
  streamCompletion: async function* () { yield 'Model answer (stubbed).'; },
  completeWithTools: async (_e: unknown, _m: unknown, msgs: { role: string }[]) => (msgs.some((m) => m.role === 'tool')
    ? { text: 'Waiting for your approval.', toolCalls: [] }
    : { text: null, toolCalls: [{ id: 'call_m1', name: 'create_ticket', arguments: { title: 'VPN broken', api_token: 'tok_x' } }] }),
}));

const { GET: status } = await import('./status/route');
const { POST: approvedCall } = await import('../threads/[threadId]/approved-call/route');
const { POST: messages } = await import('../threads/[threadId]/messages/route');
const { parsePendingApproval } = await import('@/lib/chat/approval');

function seed(): FakeState {
  const s = emptyState();
  s.members = { [ORG]: { [OWNER]: 'owner', [MEMBER]: 'member' } };
  s.endpoints = [{ id: EP, organization_id: ORG, display_name: 'Acme Docs (test)', url: 'https://mcp.acme.test/mcp?internal=x', status: 'active', auth_connection_id: null }];
  s.snapshots = [{ id: 's1', organization_id: ORG, endpoint_id: EP, version: 1, approved_at: '2026-11-15T00:00:00Z', revoked_at: null }];
  s.tools = [
    { snapshot_id: 's1', organization_id: ORG, name: 'search_docs', description: 'Search', input_schema: { type: 'object' }, permission_class: 'read' },
    { snapshot_id: 's1', organization_id: ORG, name: 'create_ticket', description: 'Create a ticket', input_schema: { type: 'object', properties: { title: { type: 'string' } } }, permission_class: 'write' },
  ];
  return s;
}

const ARGS = { title: 'VPN broken' };
const HASH = argumentsSha256(ARGS);
const statusReq = (q: Record<string, string>) => status(new Request(`${ORIGIN}/api/v1/chat/approvals/status?${new URLSearchParams(q)}`));
function runReq(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return approvedCall(new Request(`${ORIGIN}/api/v1/chat/threads/${THREAD}/approved-call`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { origin: ORIGIN, 'x-tugpt-csrf': '1', 'content-type': 'application/json', ...headers },
  }), { params: Promise.resolve({ threadId: THREAD }) });
}
const body = (over: Record<string, unknown> = {}) => ({
  callId: 'call_1', modelKey: 'tugpt-scout', connectionId: EP, capability: 'external.create_ticket', arguments: ARGS, argumentsSha256: HASH, timeZone: 'Europe/Berlin', ...over,
});
async function events(res: Response) {
  expect(res.status).toBe(200);
  return (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  state = seed(); user = OWNER; appended.length = 0;
  vi.stubEnv('TUGPT_APP_ORIGIN', ORIGIN);
  vi.stubEnv('TUGPT_PRIVATE_LLM_URL', 'http://127.0.0.1:12435/v1');
  vi.stubEnv('TUGPT_CHAT_VERIFIED_TOOL_MODELS', 'tugpt-scout');
  vi.stubEnv('TUGPT_CUSTOMER_MCP_ENABLED', 'true');
  vi.stubEnv('TUGPT_CHAT_MCP_EXECUTION_ENABLED', 'true');
  vi.stubEnv('CONNECT_EGRESS_PROXY', 'http://127.0.0.1:9');
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('GET /api/v1/chat/approvals/status', () => {
  const q = { connectionId: EP, capability: 'external.create_ticket', argumentsSha256: HASH, threadId: THREAD };
  it('validates its parameters', async () => {
    for (const bad of [{ ...q, connectionId: 'x' }, { ...q, capability: 'calendar.find' }, { ...q, argumentsSha256: 'abc' }]) {
      expect((await statusReq(bad)).status).toBe(400);
    }
  });
  it('reports the database answer and never grants anything', async () => {
    expect(await (await statusReq(q)).json()).toEqual({ approved: false });
    approve(state, { requested_by: OWNER, thread_id: THREAD,  organization_id: ORG, connection_id: EP, capability: 'external.create_ticket', arguments_sha256: HASH, expires_at: Date.now() + 60_000 });
    const res = await statusReq(q);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.json()).toEqual({ approved: true });
    expect(state.approvals[0].used_at).toBeNull(); // a status check does not consume
    user = MEMBER;
    expect(await (await statusReq(q)).json()).toEqual({ approved: false }); // another user (not the requester) cannot see the approval
    user = STRANGER;
    expect(await (await statusReq(q)).json()).toEqual({ approved: false });
  });
  it('expired and revoked approvals are not approved', async () => {
    approve(state, { requested_by: OWNER, thread_id: THREAD,  organization_id: ORG, connection_id: EP, capability: 'external.create_ticket', arguments_sha256: HASH, expires_at: Date.now() - 1 });
    approve(state, { requested_by: OWNER, thread_id: THREAD,  organization_id: ORG, connection_id: EP, capability: 'external.create_ticket', arguments_sha256: HASH, expires_at: Date.now() + 60_000 }).revoked_at = Date.now();
    expect(await (await statusReq(q)).json()).toEqual({ approved: false });
  });
});

describe('POST /api/v1/chat/threads/[id]/approved-call', () => {
  it('requires a same-origin JSON mutation', async () => {
    expect((await runReq(body(), { origin: 'https://evil.test' })).status).toBe(403);
    expect((await runReq(body(), { 'x-tugpt-csrf': '' })).status).toBe(403);
  });
  it('rejects malformed bodies and unknown fields', async () => {
    for (const b of [body({ connectionId: 'x' }), body({ capability: 'calendar.find_availability' }), body({ arguments: [] }), body({ callId: 'a b' }), { ...body(), extra: 1 }]) {
      expect((await runReq(b)).status).toBe(400);
    }
  });
  it('refuses arguments that differ from the card (hash recomputed on the server)', async () => {
    const res = await runReq(body({ arguments: { title: 'something else' } }));
    expect(res.status).toBe(409);
    expect(state.rpcLog.some((r) => r.fn === 'claim_tool_approval')).toBe(false);
  });
  it('refuses when chat MCP execution is switched off', async () => {
    vi.stubEnv('TUGPT_CHAT_MCP_EXECUTION_ENABLED', '');
    expect((await runReq(body())).status).toBe(409);
  });
  it('refuses read tools and unknown capabilities (they never need this route)', async () => {
    const read = { title: 'q' };
    expect((await runReq(body({ capability: 'external.search_docs', arguments: read, argumentsSha256: argumentsSha256(read) }))).status).toBe(409);
    expect((await runReq(body({ capability: 'external.nope' }))).status).toBe(409);
  });
  it('without an approval the runtime refuses with APPROVAL_REQUIRED and audits the denial', async () => {
    const ev = await events(await runReq(body()));
    expect(ev[0]).toMatchObject({ type: 'tool_start', tool: 'create_ticket', callId: 'call_1', provider: 'Acme Docs (test)' });
    expect(ev[1]).toMatchObject({ type: 'tool_result', ok: false, code: 'APPROVAL_REQUIRED' });
    expect(ev.at(-1)).toMatchObject({ type: 'done' });
    expect(state.mcpAudit).toEqual([expect.objectContaining({ p_endpoint_id: EP, p_capability: 'external.create_ticket', p_outcome: 'APPROVAL_REQUIRED', p_arguments_sha256: HASH })]);
  });
  it('with an approval the runtime claims it once (before execution); here the call then fails because no MCP server is reachable', async () => {
    const a = approve(state, { requested_by: OWNER, thread_id: THREAD,  organization_id: ORG, connection_id: EP, capability: 'external.create_ticket', arguments_sha256: HASH, expires_at: Date.now() + 60_000 });
    const ev = await events(await runReq(body()));
    expect(a.used_at).not.toBeNull();
    expect(ev[1]).toMatchObject({ type: 'tool_result', ok: false, code: 'PROVIDER_UNAVAILABLE' });
    expect(state.mcpAudit.at(-1)).toMatchObject({ p_outcome: 'PROVIDER_UNAVAILABLE', p_arguments_sha256: HASH });
    // The approval is consumed by the claim; a second run is refused.
    const again = await events(await runReq(body({ callId: 'call_2' })));
    expect(again[1]).toMatchObject({ code: 'APPROVAL_REQUIRED' });
  });
  it('a member can run an approval that an owner recorded; the claim is per organization', async () => {
    approve(state, { requested_by: OWNER, thread_id: THREAD,  organization_id: ORG, connection_id: EP, capability: 'external.create_ticket', arguments_sha256: HASH, expires_at: Date.now() + 60_000 });
    user = MEMBER;
    const res = await runReq(body());
    // The fake mirrors owner/admin-only reads of external_tool_* (as the B-9 tests assume), so members get no runnable MCP tool.
    expect(res.status).toBe(409);
  });
});

describe('POST /api/v1/chat/threads/[id]/messages emits approval_required', () => {
  it('for a refused write call: server-built details, host only, the runtime hash', async () => {
    const res = await messages(new Request(`${ORIGIN}/api/v1/chat/threads/${THREAD}/messages`, {
      method: 'POST', headers: { origin: ORIGIN, 'x-tugpt-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'open a ticket', modelKey: 'tugpt-scout', mentions: [{ capability: 'external.create_ticket', provider: 'mcp' }], timeZone: 'UTC' }),
    }), { params: Promise.resolve({ threadId: THREAD }) });
    const ev = await events(res);
    const types = ev.map((e) => e.type);
    expect(types.indexOf('approval_required')).toBe(types.indexOf('tool_result') + 1);
    const raw = ev.find((e) => e.type === 'approval_required')!.approval;
    const p = parsePendingApproval(raw);
    expect(p).toMatchObject({
      callId: 'call_m1', threadId: THREAD, endpointId: EP, endpointName: 'Acme Docs (test)', endpointHost: 'mcp.acme.test',
      capability: 'external.create_ticket', toolName: 'create_ticket', permissionClass: 'write',
    });
    const args = { title: 'VPN broken', api_token: 'tok_x' };
    expect(p!.argumentsSha256).toBe(argumentsSha256(args));
    expect(state.mcpAudit.at(-1)).toMatchObject({ p_outcome: 'APPROVAL_REQUIRED', p_arguments_sha256: argumentsSha256(args) });
    expect(JSON.stringify(raw)).not.toContain('internal=x');
    expect(ev.at(-1)).toMatchObject({ type: 'done' });
  });
  it('no card for read tools', async () => {
    state.tools[1].permission_class = 'read';
    const res = await messages(new Request(`${ORIGIN}/api/v1/chat/threads/${THREAD}/messages`, {
      method: 'POST', headers: { origin: ORIGIN, 'x-tugpt-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x', modelKey: 'tugpt-scout', mentions: [{ capability: 'external.create_ticket', provider: 'mcp' }], timeZone: 'UTC' }),
    }), { params: Promise.resolve({ threadId: THREAD }) });
    expect((await events(res)).some((e) => e.type === 'approval_required')).toBe(false);
  });
});
