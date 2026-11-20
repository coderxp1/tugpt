/**
 * POST /api/v1/connect/mcp/approvals audit (20261120000010).
 * REAL: the route handler and the repository's record_tool_approval error mapping.
 * MOCKED (labelled): the PostgREST client (records rpc calls; returns PostgREST error shapes),
 * session/tenant (AuthService, role per test) and the customer MCP flag (on).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://app.test';
const ORG = 'a5000000-0000-4000-8000-00000000000a';
const EP = 'a5000000-0000-4000-8000-0000000e0001';
const THREAD = 'a5000000-0000-4000-8000-0000000c0001';
const HASH = 'ab'.repeat(32);
const st = vi.hoisted(() => ({ role: 'owner', calls: [] as { fn: string; args: Record<string, unknown> }[], approveError: null as null | { code: string; message: string } }));

vi.mock('@/lib/supabase/server', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/server')>()),
  createAuthenticatedServerClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      st.calls.push({ fn, args });
      if (fn === 'record_tool_approval') return st.approveError ? { data: null, error: st.approveError } : { data: [{ id: 'ap-1', expires_at: '2026-11-21T00:00:00Z' }], error: null };
      return { data: null, error: null };
    },
  }),
}));
vi.mock('@tugpt/auth', async (orig) => ({
  ...(await orig<typeof import('@tugpt/auth')>()),
  AuthService: class {
    async getCurrentUser() { return { id: 'u-1' }; }
    async resolveTenantContext() { return { organizationId: ORG, organizationName: 'Org', role: st.role }; }
  },
}));
vi.mock('@/lib/connect-ui/flags.server', () => ({ customerMcpEnabled: () => true }));

const { POST } = await import('./route');
const HEADERS = { origin: ORIGIN, 'x-tugpt-csrf': '1', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-tenant-id': ORG };
const req = (b: Record<string, unknown>) => POST(new Request(`${ORIGIN}/api/v1/connect/mcp/approvals`, { method: 'POST', headers: HEADERS, body: JSON.stringify(b) }));
const valid = { connectionId: EP, capability: 'external.create_entities', argumentsSha256: HASH, ttlSeconds: 600, threadId: THREAD };

beforeEach(() => { vi.stubEnv('TUGPT_APP_ORIGIN', ORIGIN); st.role = 'owner'; st.calls = []; st.approveError = null; });
afterEach(() => { vi.unstubAllEnvs(); });

describe('approval route audit', () => {
  it('a non-approver gets 403 and the denial is recorded (hash only, in the caller organization)', async () => {
    st.role = 'agent';
    expect((await req(valid)).status).toBe(403);
    expect(st.calls.filter((c) => c.fn === 'record_tool_approval')).toHaveLength(0);
    expect(st.calls).toEqual([{ fn: 'record_mcp_approval_event', args: {
      p_organization_id: ORG, p_event: 'authorization_denied', p_reason: 'APPROVER_ROLE_REQUIRED',
      p_connection_id: EP, p_capability: 'external.create_entities', p_arguments_sha256: HASH, p_thread_id: THREAD,
    } }]);
  });
  it('a malformed denied request records nothing it cannot validate', async () => {
    st.role = 'agent';
    expect((await req({ ...valid, argumentsSha256: 'nope', connectionId: 'x' })).status).toBe(403);
    expect(st.calls).toHaveLength(0);
  });
  it('a call the user rejected cannot be approved: 409', async () => {
    st.approveError = { code: 'P0001', message: 'CALL_REJECTED' };
    const res = await req(valid);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('CALL_REJECTED');
  });
  it('the database FORBIDDEN is still a 403 and is recorded', async () => {
    st.approveError = { code: '42501', message: 'FORBIDDEN' };
    expect((await req(valid)).status).toBe(403);
    expect(st.calls.at(-1)).toMatchObject({ fn: 'record_mcp_approval_event', args: { p_reason: 'APPROVER_ROLE_REQUIRED' } });
  });
  it.each([
    ['INVALID_THREAD', 'THREAD_NOT_ACCESSIBLE'],
    ['INVALID_ENDPOINT', 'ENDPOINT_NOT_ACTIVE'],
  ])('an approval for a thread/endpoint outside the caller organization (%s) is a 400 and is recorded as %s in the caller organization', async (dbMessage, reason) => {
    st.approveError = { code: '22023', message: dbMessage };
    const res = await req(valid);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_REQUEST');
    expect(st.calls.map((c) => c.fn)).toEqual(['record_tool_approval', 'record_mcp_approval_event']);
    expect(st.calls.at(-1)).toEqual({ fn: 'record_mcp_approval_event', args: {
      p_organization_id: ORG, p_event: 'authorization_denied', p_reason: reason,
      p_connection_id: EP, p_capability: 'external.create_entities', p_arguments_sha256: HASH, p_thread_id: THREAD,
    } });
  });
  it('other invalid-input errors stay a 400 and record nothing', async () => {
    st.approveError = { code: '22023', message: 'INVALID_CAPABILITY' };
    expect((await req(valid)).status).toBe(400);
    expect(st.calls.map((c) => c.fn)).toEqual(['record_tool_approval']);
  });
  it('an approver records the approval (the approved event is written by the database trigger)', async () => {
    expect((await req(valid)).status).toBe(200);
    expect(st.calls.map((c) => c.fn)).toEqual(['record_tool_approval']);
  });
});
