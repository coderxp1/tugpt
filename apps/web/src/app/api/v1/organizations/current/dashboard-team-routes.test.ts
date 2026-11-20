/**
 * Dashboard team & organization routes. The database owns authorization
 * (pgTAP: dashboard_team_management.test.sql); these prove the routes pass the
 * session's organization (never a body-supplied one), refuse cross-origin
 * writes before touching the database, validate shape, map RPC errors to
 * stable codes, keep personal data out of logs, and never cache.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GET as membersGET } from './members/route';
import { PATCH as memberPATCH, DELETE as memberDELETE } from './members/[userId]/route';
import { GET as orgGET, PATCH as orgPATCH } from './route';
import { POST as transferPOST } from './transfer-ownership/route';
import { GET as meGET, PATCH as mePATCH } from '../me/route';

const mockRpc = vi.fn();
const mockFrom = vi.fn();
const mockCreateClient = vi.fn(() => Promise.resolve({ rpc: mockRpc, from: mockFrom }));
vi.mock('@/lib/supabase/server', () => ({ createAuthenticatedServerClient: () => mockCreateClient() }));

const mockGetCurrentUser = vi.fn();
const mockResolveTenantContext = vi.fn();
const mockGetUserOrganizations = vi.fn();
vi.mock('@tugpt/auth', () => ({
  AuthService: vi.fn().mockImplementation(function () {
    return { getCurrentUser: mockGetCurrentUser, resolveTenantContext: mockResolveTenantContext, getUserOrganizations: mockGetUserOrganizations };
  }),
}));

const logged: unknown[] = [];
vi.mock('@tugpt/observability', () => ({
  defaultLogger: { info: (...a: unknown[]) => logged.push(a), warn: (...a: unknown[]) => logged.push(a), error: (...a: unknown[]) => logged.push(a) },
}));

const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';
const OTHER_ORG = 'bbbbbbbb-0000-4000-8000-00000000000b';
const ME = 'cccccccc-0000-4000-8000-000000000001';
const BOB = 'cccccccc-0000-4000-8000-000000000002';

/** Chainable PostgREST stand-in: every builder method returns itself; awaiting yields `result`. */
function query(result: { data: unknown; error: unknown }) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'update']) q[m] = vi.fn(() => q);
  q.single = vi.fn(() => Promise.resolve(result));
  q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
  return q;
}

function setup(role = 'owner') {
  vi.clearAllMocks();
  logged.length = 0;
  mockGetCurrentUser.mockResolvedValue({ id: ME, email: 'me@acme.test', fullName: 'Me', avatarUrl: null });
  mockResolveTenantContext.mockResolvedValue({ organizationId: ORG, organizationName: 'Acme', role, locale: 'es' });
  mockGetUserOrganizations.mockResolvedValue([{ organizationId: ORG, organizationName: 'Acme', role, locale: 'es' }]);
}

const SAME = { origin: 'https://dashboard.example', 'x-tugpt-csrf': '1', 'content-type': 'application/json', 'x-tenant-id': ORG };
function req(method: string, body?: unknown, headers: Record<string, string> = SAME) {
  return new Request('http://localhost/api/v1/x', { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const userParams = (id: string) => ({ params: Promise.resolve({ userId: id }) });
async function json(res: Response) { return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') }; }

beforeEach(() => { vi.stubEnv('TUGPT_APP_ORIGIN', 'https://dashboard.example'); setup(); });

describe('cross-origin writes are refused before any database work', () => {
  const foreign = { origin: 'https://evil.example', 'content-type': 'application/json' };
  it.each([
    ['PATCH /members/:id', () => memberPATCH(req('PATCH', { role: 'viewer' }, foreign), userParams(BOB))],
    ['DELETE /members/:id', () => memberDELETE(req('DELETE', undefined, foreign), userParams(BOB))],
    ['PATCH /organization', () => orgPATCH(req('PATCH', { name: 'x' }, foreign))],
    ['POST /organization/transfer-ownership', () => transferPOST(req('POST', { userId: BOB }, foreign))],
    ['PATCH /me', () => mePATCH(req('PATCH', { fullName: 'x' }, foreign))],
  ])('%s', async (_n, call) => {
    const r = await json(await call());
    expect(r.status).toBe(403);
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('authentication and tenant resolution', () => {
  it('401 without a session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    expect((await membersGET(req('GET'))).status).toBe(401);
    expect((await orgGET(req('GET'))).status).toBe(401);
    expect((await meGET(req('GET'))).status).toBe(401);
  });
  it('403 when the requested organization is not one of the caller\'s', async () => {
    mockResolveTenantContext.mockResolvedValue(null);
    const r = await json(await memberPATCH(req('PATCH', { role: 'viewer' }, { ...SAME, 'x-tenant-id': OTHER_ORG }), userParams(BOB)));
    expect(r.status).toBe(403);
    expect(mockResolveTenantContext).toHaveBeenCalledWith(ME, OTHER_ORG);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('PATCH /members/:userId', () => {
  it('calls the RPC with the session organization, never a body one', async () => {
    mockRpc.mockResolvedValue({ data: { organization_id: ORG, user_id: BOB, action: 'set_role', previous_role: 'agent', role: 'manager', changed: true }, error: null });
    const r = await json(await memberPATCH(req('PATCH', { role: 'manager' }), userParams(BOB)));
    expect(r.status).toBe(200);
    expect(r.cache).toBe('private, no-store');
    expect(mockRpc).toHaveBeenCalledWith('manage_organization_member', { p_organization_id: ORG, p_user_id: BOB, p_action: 'set_role', p_role: 'manager' });
    expect(r.body.member).toEqual({ userId: BOB, action: 'set_role', previousRole: 'agent', role: 'manager', changed: true });
  });
  it('rejects unknown fields (cannot smuggle organizationId) and unknown roles', async () => {
    expect((await memberPATCH(req('PATCH', { role: 'viewer', organizationId: OTHER_ORG }), userParams(BOB))).status).toBe(400);
    expect((await memberPATCH(req('PATCH', { role: 'superadmin' }), userParams(BOB))).status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it('a non-uuid member id is a 404 without a database call', async () => {
    expect((await memberPATCH(req('PATCH', { role: 'viewer' }), userParams('../x'))).status).toBe(404);
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it.each([
    ['P3S02', 403, 'FORBIDDEN'], ['P3S07', 403, 'MEMBER_RANK_FORBIDDEN'], ['P3S06', 404, 'MEMBER_NOT_FOUND'],
    ['P3S01', 404, 'ORGANIZATION_NOT_FOUND'], ['P3S05', 409, 'LAST_OWNER'], ['P3S03', 422, 'INVALID_MEMBERSHIP_CHANGE'],
    ['XX000', 500, 'INTERNAL_ERROR'],
  ])('maps %s to %i %s without leaking the database message', async (code, status, apiCode) => {
    mockRpc.mockResolvedValue({ data: null, error: { code, message: 'secret internal detail' } });
    const r = await json(await memberPATCH(req('PATCH', { role: 'viewer' }), userParams(BOB)));
    expect(r.status).toBe(status);
    expect(r.body.error.code).toBe(apiCode);
    expect(JSON.stringify(r.body)).not.toContain('secret internal detail');
  });
});

describe('DELETE /members/:userId', () => {
  it('removes another member', async () => {
    mockRpc.mockResolvedValue({ data: { organization_id: ORG, user_id: BOB, action: 'remove', previous_role: 'agent', role: null, changed: true }, error: null });
    const res = await memberDELETE(req('DELETE'), userParams(BOB));
    const r = await json(res);
    expect(r.status).toBe(200);
    expect(r.body.left).toBe(false);
    expect(mockRpc).toHaveBeenCalledWith('manage_organization_member', { p_organization_id: ORG, p_user_id: BOB, p_action: 'remove', p_role: null });
    expect(res.headers.get('set-cookie')).toBeNull();
  });
  it('leaving clears the stale active-organization cookie', async () => {
    mockRpc.mockResolvedValue({ data: { organization_id: ORG, user_id: ME, action: 'leave', previous_role: 'agent', role: null, changed: true }, error: null });
    const res = await memberDELETE(req('DELETE'), userParams(ME));
    expect((await res.clone().json()).left).toBe(true);
    expect(res.headers.get('set-cookie')).toMatch(/tugpt_tenant_id=;.*Max-Age=0/i);
  });
});

describe('GET /members', () => {
  it('returns members with hints computed from the caller\'s role, and logs no personal data', async () => {
    setup('admin');
    mockFrom.mockImplementation((table: string) => table === 'organization_members'
      ? query({ data: [
          { user_id: 'o', role: 'owner', created_at: '2026-01-01' },
          { user_id: ME, role: 'admin', created_at: '2026-01-02' },
          { user_id: BOB, role: 'agent', created_at: '2026-01-03' }], error: null })
      : query({ data: [{ id: BOB, full_name: 'Bob', email: 'bob@acme.test', avatar_url: null }], error: null }));
    const r = await json(await membersGET(req('GET')));
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.members.map((m: { userId: string }) => [m.userId, m]));
    expect(byId.o).toMatchObject({ canChangeRole: false, canRemove: false });
    expect(byId[ME]).toMatchObject({ isSelf: true, canChangeRole: false, canRemove: true });
    expect(byId[BOB]).toMatchObject({ name: 'Bob', email: 'bob@acme.test', canChangeRole: true, canRemove: true });
    expect(r.body.permissions.assignableRoles).not.toContain('owner');
    expect(JSON.stringify(logged)).not.toContain('bob@acme.test');
  });
});

describe('/organization', () => {
  it('GET returns settings, counts and permissions for the active organization only', async () => {
    const orgQ = query({ data: { id: ORG, name: 'Acme', slug: 'acme', locale: 'es', time_zone: 'Europe/Madrid', created_at: 'x' }, error: null });
    mockFrom.mockImplementation((t: string) => t === 'organizations' ? orgQ : query({ data: [{ role: 'owner' }, { role: 'agent' }], error: null }));
    const r = await json(await orgGET(req('GET')));
    expect(r.status).toBe(200);
    expect(orgQ.eq).toHaveBeenCalledWith('id', ORG);
    expect(r.body).toMatchObject({ organization: { timeZone: 'Europe/Madrid' }, memberCount: 2, ownerCount: 1, membership: { role: 'owner' } });
  });
  it('PATCH maps camelCase to the RPC keys and rejects slug or empty bodies', async () => {
    mockRpc.mockResolvedValue({ data: { id: ORG, name: 'New', slug: 'acme', locale: 'en', time_zone: 'Europe/Madrid', changed: true }, error: null });
    const r = await json(await orgPATCH(req('PATCH', { name: 'New', locale: 'en', timeZone: 'Europe/Madrid' })));
    expect(r.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('update_organization_settings', { p_organization_id: ORG, p_changes: { name: 'New', locale: 'en', time_zone: 'Europe/Madrid' } });
    expect((await orgPATCH(req('PATCH', { slug: 'stolen' }))).status).toBe(400);
    expect((await orgPATCH(req('PATCH', {}))).status).toBe(400);
    expect((await orgPATCH(req('PATCH', { locale: 'pt' }))).status).toBe(400);
  });
  it('PATCH surfaces a refused role as 403', async () => {
    setup('manager');
    mockRpc.mockResolvedValue({ data: null, error: { code: 'P3S02' } });
    expect((await orgPATCH(req('PATCH', { name: 'x' }))).status).toBe(403);
  });
});

describe('POST /organization/transfer-ownership', () => {
  it('requires a uuid and passes the session organization', async () => {
    expect((await transferPOST(req('POST', { userId: 'nope' }))).status).toBe(400);
    mockRpc.mockResolvedValue({ data: { organization_id: ORG, owner_id: BOB }, error: null });
    const r = await json(await transferPOST(req('POST', { userId: BOB })));
    expect(r.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('transfer_organization_ownership', { p_organization_id: ORG, p_new_owner_id: BOB });
  });
});

describe('/me', () => {
  it('PATCH updates only the caller\'s own row with whitelisted columns', async () => {
    const q = query({ data: { id: ME, email: 'me@acme.test', full_name: 'Ana', avatar_url: null, preferred_locale: 'en' }, error: null });
    mockFrom.mockReturnValue(q);
    const r = await json(await mePATCH(req('PATCH', { fullName: '  Ana ', preferredLocale: 'en' })));
    expect(r.status).toBe(200);
    expect(q.update).toHaveBeenCalledWith({ full_name: 'Ana', preferred_locale: 'en' });
    expect(q.eq).toHaveBeenCalledWith('id', ME);
    expect(JSON.stringify(logged)).not.toContain('Ana');
  });
  it('PATCH refuses email, unknown locales and empty bodies', async () => {
    expect((await mePATCH(req('PATCH', { email: 'x@y.z' }))).status).toBe(400);
    expect((await mePATCH(req('PATCH', { preferredLocale: 'fr' }))).status).toBe(400);
    expect((await mePATCH(req('PATCH', {}))).status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });
  it('GET works for a user with no organization', async () => {
    mockResolveTenantContext.mockResolvedValue(null);
    mockGetUserOrganizations.mockResolvedValue([]);
    mockFrom.mockReturnValue(query({ data: { id: ME, email: 'me@acme.test', full_name: null, avatar_url: null, preferred_locale: 'es' }, error: null }));
    const r = await json(await meGET(req('GET')));
    expect(r.status).toBe(200);
    expect(r.body.activeOrganization).toBeNull();
    expect(r.body.organizations).toEqual([]);
  });
});
