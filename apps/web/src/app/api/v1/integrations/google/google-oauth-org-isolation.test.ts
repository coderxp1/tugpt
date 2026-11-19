/**
 * @file google-oauth-org-isolation.test.ts
 * @description Can the active-organization selection be manipulated to act
 * on another organization's Google connection?
 *
 * Unlike google-oauth-routes.test.ts (which mocks AuthService at the module
 * seam with a resolver that trusts the hint), these tests run the REAL
 * `AuthService.resolveTenantContext` against a fake Supabase client whose
 * `organization_members` rows play the part RLS plays in production: they
 * are the caller's own memberships and nothing else.
 *
 * The proxy forwards `x-tenant-id` from the `tugpt_tenant_id` cookie or, if
 * there is no cookie, from the client's own header — it does not strip a
 * client-supplied value (proxy.test.ts pins that). These routes also accept
 * a `?tenant=` hint. So every one of those inputs is attacker-controlled and
 * must be treated as a REQUEST, never as authorization.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as startGET } from './start/route';
import { POST as disconnectPOST } from './disconnect/route';

const USER_ID = 'bbbbbbbb-1111-4111-8111-111111111111';
const ORG_MINE = 'aaaaaaaa-2222-4333-8444-555555555555';
const ORG_MINE_AS_AGENT = 'dddddddd-2222-4333-8444-555555555555';
const ORG_OTHER = 'cccccccc-9999-4999-8999-999999999999';

type Membership = { organization_id: string; role: string };
let memberships: Membership[] = [];
const membershipQueries: Array<{ column: string; value: string }> = [];

function fakeSupabase() {
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: USER_ID, email: 'admin@example.com', user_metadata: {} } }, error: null })),
    },
    from: vi.fn((table: string) => {
      if (table === 'profiles') {
        return { select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) };
      }
      if (table === 'organization_members') {
        return {
          select: () => ({
            eq: async (column: string, value: string) => {
              membershipQueries.push({ column, value });
              // RLS in production returns only the caller's own rows; the
              // fake returns only rows for the queried user, i.e. the session user.
              const rows = value === USER_ID ? memberships : [];
              return {
                data: rows.map((m) => ({
                  organization_id: m.organization_id,
                  role: m.role,
                  organizations: { id: m.organization_id, name: `Org ${m.organization_id.slice(0, 4)}`, locale: 'en', deleted_at: null },
                })),
                error: null,
              };
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };
}

const oauthMocks = vi.hoisted(() => ({
  createGoogleConsent: vi.fn(),
  revokeGoogleConnection: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createAuthenticatedServerClient: vi.fn(async () => fakeSupabase()),
}));

vi.mock('@tugpt/database', () => ({
  createAdminSupabaseClient: vi.fn(() => ({})),
  normalizeOrganizationLocale: (v: unknown) => (v === 'es' ? 'es' : 'en'),
}));

vi.mock('@tugpt/appointments', () => {
  class GoogleOAuthError extends Error {
    constructor(message: string, readonly code: string) {
      super(message);
    }
  }
  return {
    GoogleOAuthError,
    createGoogleConsent: oauthMocks.createGoogleConsent,
    verifyGoogleOAuthState: vi.fn(),
    completeGoogleOAuthCallback: vi.fn(),
    revokeGoogleConnection: oauthMocks.revokeGoogleConnection,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  membershipQueries.length = 0;
  memberships = [
    { organization_id: ORG_MINE, role: 'owner' },
    { organization_id: ORG_MINE_AS_AGENT, role: 'agent' },
  ];
  oauthMocks.createGoogleConsent.mockResolvedValue({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s', expiresAt: '2026-11-13T00:10:00Z' });
  oauthMocks.revokeGoogleConnection.mockResolvedValue({ localDeleted: true, remoteRevoked: true });
});

function start(headers: Record<string, string> = {}, query = ''): Request {
  return new Request(`http://localhost/api/v1/integrations/google/start${query}`, { headers });
}
// Legitimate same-origin form post: passes the CSRF Origin guard so these tests
// exercise tenant selection behind it (a 403 would also "revoke nothing").
const APP_ORIGIN = 'https://app.test';
function disconnect(headers: Record<string, string> = {}, query = ''): Request {
  vi.stubEnv('TUGPT_APP_ORIGIN', APP_ORIGIN);
  return new Request(`http://localhost/api/v1/integrations/google/disconnect${query}`, {
    method: 'POST',
    headers: { origin: APP_ORIGIN, 'sec-fetch-site': 'same-origin', ...headers },
  });
}

describe('active-organization selection cannot reach another organization (real AuthService)', () => {
  it('start: a forged x-tenant-id for a non-member org is refused with 403 and mints no state', async () => {
    const res = await startGET(start({ 'x-tenant-id': ORG_OTHER }));
    expect(res.status).toBe(403);
    expect(oauthMocks.createGoogleConsent).not.toHaveBeenCalled();
  });

  it('start: a forged ?tenant= for a non-member org is refused with 403', async () => {
    const res = await startGET(start({}, `?tenant=${ORG_OTHER}`));
    expect(res.status).toBe(403);
    expect(oauthMocks.createGoogleConsent).not.toHaveBeenCalled();
  });

  it('start: a forged selection does NOT silently fall back to the default org for a mutation', async () => {
    // The page-rendering resolver falls back to the default org; API routes
    // must not, or a forged header would act on the user's first org instead.
    const res = await startGET(start({ 'x-tenant-id': ORG_OTHER }));
    expect(res.status).toBe(403);
    expect(oauthMocks.createGoogleConsent).not.toHaveBeenCalled();
  });

  it('start: membership is looked up for the SESSION user, never for a user named by the request', async () => {
    await startGET(start({ 'x-tenant-id': ORG_OTHER, 'x-user-id': 'eeeeeeee-0000-4000-8000-000000000000' }));
    expect(membershipQueries).toEqual([{ column: 'user_id', value: USER_ID }]);
  });

  it('start: selecting an org where the user is only an agent is refused (role is per-org)', async () => {
    const res = await startGET(start({ 'x-tenant-id': ORG_MINE_AS_AGENT }));
    expect(res.status).toBe(403);
    expect(oauthMocks.createGoogleConsent).not.toHaveBeenCalled();
  });

  it('start: a valid selection binds consent to that org and the session user', async () => {
    const res = await startGET(start({ 'x-tenant-id': ORG_MINE }));
    expect(res.status).toBe(307);
    const args = oauthMocks.createGoogleConsent.mock.calls[0]?.[1] as { organizationId: string; userId: string };
    expect(args).toMatchObject({ organizationId: ORG_MINE, userId: USER_ID });
  });

  it('start: a removed membership (stale cookie) is refused, not re-pointed', async () => {
    memberships = [{ organization_id: ORG_MINE_AS_AGENT, role: 'agent' }];
    const res = await startGET(start({ 'x-tenant-id': ORG_MINE }));
    expect(res.status).toBe(403);
    expect(oauthMocks.createGoogleConsent).not.toHaveBeenCalled();
  });

  it('disconnect: a forged x-tenant-id for a non-member org revokes nothing', async () => {
    const res = await disconnectPOST(disconnect({ 'x-tenant-id': ORG_OTHER }));
    expect(res.status).toBe(403);
    expect(oauthMocks.revokeGoogleConnection).not.toHaveBeenCalled();
  });

  it('disconnect: a forged ?tenant= for a non-member org revokes nothing', async () => {
    const res = await disconnectPOST(disconnect({}, `?tenant=${ORG_OTHER}`));
    expect(res.status).toBe(403);
    expect(oauthMocks.revokeGoogleConnection).not.toHaveBeenCalled();
  });

  it('disconnect: a valid selection revokes only that org', async () => {
    const res = await disconnectPOST(disconnect({ 'x-tenant-id': ORG_MINE }));
    expect(res.status).toBe(303);
    expect(oauthMocks.revokeGoogleConnection).toHaveBeenCalledTimes(1);
    expect(oauthMocks.revokeGoogleConnection.mock.calls[0]?.[1]).toEqual({ organizationId: ORG_MINE });
  });
});
