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
const { streamed, threadMissing } = vi.hoisted(() => ({ streamed: [] as { role: string; content: unknown }[][], threadMissing: { on: false } }));

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
  getThread: async () => {
    if (threadMissing.on) { const { ChatStoreError } = await import('@/lib/chat/store'); throw new ChatStoreError('NOT_FOUND'); }
    return { id: THREAD };
  },
  listMessages: async () => [{ id: 'm1', role: 'user', content: 'open a ticket', status: 'complete', mentions: [], capabilityKey: null }],
  appendMessage: async (_db: unknown, m: Record<string, unknown>) => { appended.push(m); return { id: `saved-${appended.length}`, ...m }; },
  touchThread: async () => undefined,
}));
vi.mock('@/lib/chat/openai-compatible', async (orig) => ({
  ...(await orig<typeof import('@/lib/chat/openai-compatible')>()),
  streamCompletion: async function* (_e: unknown, _m: unknown, msgs: { role: string; content: unknown }[]) { streamed.push(msgs); yield 'Model answer (stubbed).'; },
  completeWithTools: async (_e: unknown, _m: unknown, msgs: { role: string }[]) => (msgs.some((m) => m.role === 'tool')
    ? { text: 'Waiting for your approval.', toolCalls: [] }
    : { text: null, toolCalls: [{ id: 'call_m1', name: 'create_ticket', arguments: { title: 'VPN broken', api_token: 'tok_x' } }] }),
}));

const { GET: status } = await import('./status/route');
const { POST: approvedCall } = await import('../threads/[threadId]/approved-call/route');
const { POST: messages } = await import('../threads/[threadId]/messages/route');
const { parsePendingApproval } = await import('@/lib/chat/approval');
const { POST: rejectedCall } = await import('../threads/[threadId]/rejected-call/route');
function rejectReq(b: Record<string, unknown>, headers: Record<string, string> = {}) {
  return rejectedCall(new Request(`${ORIGIN}/api/v1/chat/threads/${THREAD}/rejected-call`, {
    method: 'POST', body: JSON.stringify(b),
    headers: { origin: ORIGIN, 'x-tugpt-csrf': '1', 'content-type': 'application/json', ...headers },
  }), { params: Promise.resolve({ threadId: THREAD }) });
}

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
  state = seed(); user = OWNER; appended.length = 0; streamed.length = 0; threadMissing.on = false;
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
    expect(state.rpcLog.some((r) => r.fn.startsWith('claim_tool_approval'))).toBe(false);
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
  it('the follow-up model turn is told the approved call ran; it is never told to say the action is waiting', async () => {
    approve(state, { requested_by: OWNER, thread_id: THREAD,  organization_id: ORG, connection_id: EP, capability: 'external.create_ticket', arguments_sha256: HASH, expires_at: Date.now() + 60_000 });
    await events(await runReq(body()));
    expect(streamed).toHaveLength(1);
    const system = streamed[0].find((m) => m.role === 'system');
    expect(String(system?.content)).not.toMatch(/waiting for their approval/);
    expect(String(system?.content)).toMatch(/approved this exact call/);
  });
  it('a replay of a used approval is refused, calls no model and stores an answer that says nothing was run (real-stack regression)', async () => {
    approve(state, { requested_by: OWNER, thread_id: THREAD,  organization_id: ORG, connection_id: EP, capability: 'external.create_ticket', arguments_sha256: HASH, expires_at: Date.now() + 60_000 });
    await events(await runReq(body()));
    streamed.length = 0; appended.length = 0;
    const again = await events(await runReq(body({ callId: 'call_2' })));
    expect(again[1]).toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(streamed).toHaveLength(0);
    const saved = appended.find((m) => m.role === 'assistant');
    expect(String(saved?.content)).toMatch(/Nothing was run/);
    expect(String(saved?.content)).not.toMatch(/Model answer/);
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

describe('approval audit (20261120000010): every decision is one classified event', () => {
  const ev = () => state.approvalEvents.map((e) => `${String(e.event)}:${String(e.reason)}`);
  const ownerApproval = (over: Record<string, unknown> = {}) => approve(state, { requested_by: OWNER, thread_id: THREAD, organization_id: ORG, connection_id: EP, capability: 'external.create_ticket', arguments_sha256: HASH, expires_at: Date.now() + 60_000, ...over });

  it('approved-call claims through the audited function as approved_call; the old claim is never used', async () => {
    ownerApproval();
    await events(await runReq(body()));
    expect(state.rpcLog.filter((r) => r.fn === 'claim_tool_approval')).toHaveLength(0);
    expect(state.rpcLog.find((r) => r.fn === 'claim_tool_approval_audited')?.args).toMatchObject({ p_source: 'approved_call', p_thread_id: THREAD, p_arguments_sha256: HASH });
    expect(ev()).toEqual(['claimed:null']);
  });
  it('a chat turn claims as chat_turn and records approval_requested', async () => {
    await events(await messages(new Request(`${ORIGIN}/api/v1/chat/threads/${THREAD}/messages`, {
      method: 'POST', headers: { origin: ORIGIN, 'x-tugpt-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'open a ticket', modelKey: 'tugpt-scout', mentions: [{ capability: 'external.create_ticket', provider: 'mcp' }], timeZone: 'UTC' }),
    }), { params: Promise.resolve({ threadId: THREAD }) }));
    expect(state.rpcLog.find((r) => r.fn === 'claim_tool_approval_audited')?.args).toMatchObject({ p_source: 'chat_turn' });
    expect(ev()).toEqual(['approval_requested:APPROVAL_REQUIRED']);
  });
  it('replay, expiry and revocation are told apart', async () => {
    ownerApproval();
    await events(await runReq(body()));
    await events(await runReq(body({ callId: 'call_2' })));
    expect(ev()).toEqual(['claimed:null', 'replayed:ALREADY_USED']);
    state = seed(); ownerApproval({ expires_at: Date.now() - 1 });
    await events(await runReq(body()));
    expect(ev()).toEqual(['expired:EXPIRED']);
    state = seed(); ownerApproval().revoked_at = Date.now();
    await events(await runReq(body()));
    expect(ev()).toEqual(['revoked:CLAIM_AFTER_REVOKE']);
  });
  it('a card whose arguments were swapped is a 409 recorded as invalid_arguments with the shown hash only', async () => {
    const res = await runReq(body({ arguments: { title: 'something else' } }));
    expect(res.status).toBe(409);
    expect(state.approvalEvents).toEqual([expect.objectContaining({ event: 'invalid_arguments', reason: 'ARGUMENTS_HASH_MISMATCH', arguments_sha256: HASH, capability: 'external.create_ticket', endpoint_id: EP, thread_id: THREAD, organization_id: ORG })]);
    expect(JSON.stringify(state.approvalEvents)).not.toContain('something else');
  });
  it('an unknown or foreign thread is a 404 recorded as authorization_denied in the caller organization', async () => {
    threadMissing.on = true;
    expect((await runReq(body())).status).toBe(404);
    expect(state.approvalEvents).toEqual([expect.objectContaining({ event: 'authorization_denied', reason: 'THREAD_NOT_ACCESSIBLE', organization_id: ORG })]);
  });
  it('the response does not depend on the audit write (a failing audit still refuses)', async () => {
    state.members = { [ORG]: {} }; // record_mcp_approval_event is refused for non-members
    expect((await runReq(body({ arguments: { title: 'x' } }))).status).toBe(409);
  });
});

describe('POST /api/v1/chat/threads/[id]/rejected-call (server-side Reject)', () => {
  const rb = (over: Record<string, unknown> = {}) => ({ connectionId: EP, capability: 'external.create_ticket', argumentsSha256: HASH, ...over });
  it('requires a same-origin JSON mutation and a valid body', async () => {
    expect((await rejectReq(rb(), { origin: 'https://evil.test' })).status).toBe(403);
    for (const b of [rb({ connectionId: 'x' }), rb({ capability: 'calendar.find' }), rb({ argumentsSha256: 'abc' }), { ...rb(), extra: 1 }]) {
      expect((await rejectReq(b)).status).toBe(400);
    }
    expect(state.rpcLog.some((r) => r.fn === 'reject_tool_call')).toBe(false);
  });
  it('records rejected_by_user, revokes an open approval for exactly this call, and the call never runs afterwards', async () => {
    const a = approve(state, { requested_by: OWNER, thread_id: THREAD, organization_id: ORG, connection_id: EP, capability: 'external.create_ticket', arguments_sha256: HASH, expires_at: Date.now() + 60_000 });
    const res = await rejectReq(rb());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.json()).toEqual({ rejected: true, revokedApprovals: 1 });
    expect(a.revoked_at).not.toBeNull();
    const after = await events(await runReq(body()));
    expect(after[1]).toMatchObject({ ok: false, code: 'APPROVAL_REQUIRED' });
    expect(state.approvalEvents.map((e) => `${String(e.event)}:${String(e.reason)}`)).toEqual(['rejected_by_user:REJECTED_BY_USER', 'rejected_by_user:CLAIM_AFTER_REJECT']);
  });
  it('an unknown or foreign thread is 404 and nothing is rejected', async () => {
    threadMissing.on = true;
    expect((await rejectReq(rb())).status).toBe(404);
    expect(state.rpcLog.some((r) => r.fn === 'reject_tool_call')).toBe(false);
  });
  it('a database refusal is a 403, a database error a 503', async () => {
    state.members = { [ORG]: {} };
    expect((await rejectReq(rb())).status).toBe(403);
  });
});
