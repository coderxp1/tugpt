/**
 * @file google-oauth-routes.test.ts
 * @description GET /api/v1/integrations/google/start and .../callback.
 *
 * The OAuth flow itself is tested in @tugpt/appointments against a real
 * encrypted vault; these tests mock it at the module seam and prove the
 * ROUTES' contract: the organization and user come from the session and
 * the signed state — never from the request; only owners/admins may
 * connect; membership is re-verified before the code is exchanged; an
 * unprovisioned integration answers 503/typed reasons, never a redirect
 * to Google with invented credentials; outcomes redirect only to the
 * fixed settings path.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GET as startGET } from './start/route';
import { GET as callbackGET } from './callback/route';
import { POST as disconnectPOST } from './disconnect/route';

const mockGetCurrentUser = vi.fn();
const mockResolveTenantContext = vi.fn();
const oauthMocks = vi.hoisted(() => ({
  createGoogleConsent: vi.fn(),
  verifyGoogleOAuthState: vi.fn(),
  completeGoogleOAuthCallback: vi.fn(),
  revokeGoogleConnection: vi.fn(),
}));
const mockCreateConsent = oauthMocks.createGoogleConsent;
const mockVerifyState = oauthMocks.verifyGoogleOAuthState;
const mockComplete = oauthMocks.completeGoogleOAuthCallback;
const mockRevoke = oauthMocks.revokeGoogleConnection;

vi.mock('@/lib/supabase/server', () => ({
  createAuthenticatedServerClient: vi.fn(() => Promise.resolve({})),
}));

vi.mock('@tugpt/database', () => ({
  createAdminSupabaseClient: vi.fn(() => ({})),
}));

vi.mock('@tugpt/auth', () => ({
  AuthService: vi.fn().mockImplementation(function () {
    return {
      getCurrentUser: mockGetCurrentUser,
      resolveTenantContext: mockResolveTenantContext,
    };
  }),
}));

vi.mock('@tugpt/appointments', () => {
  class GoogleOAuthError extends Error {
    constructor(
      message: string,
      readonly code: string
    ) {
      super(message);
      this.name = 'GoogleOAuthError';
    }
  }
  return {
    GoogleOAuthError,
    createGoogleConsent: oauthMocks.createGoogleConsent,
    verifyGoogleOAuthState: oauthMocks.verifyGoogleOAuthState,
    completeGoogleOAuthCallback: oauthMocks.completeGoogleOAuthCallback,
    revokeGoogleConnection: oauthMocks.revokeGoogleConnection,
  };
});

const USER_ID = 'bbbbbbbb-1111-1111-1111-111111111111';
const ORG_ID = 'aaaaaaaa-2222-3333-4444-555555555555';

async function oauthError(code: string): Promise<Error> {
  const mod = (await import('@tugpt/appointments')) as unknown as {
    GoogleOAuthError: new (message: string, code: string) => Error;
  };
  return new mod.GoogleOAuthError('stubbed', code);
}

function setup(role: string | null = 'owner') {
  vi.clearAllMocks();
  delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
  mockGetCurrentUser.mockResolvedValue({ id: USER_ID, email: 'admin@example.com' });
  mockResolveTenantContext.mockImplementation(
    async (_userId: string, hint?: string | null) =>
      role === null
        ? null
        : {
            organizationId: hint ?? ORG_ID,
            organizationName: 'Panadería La Espiga',
            role,
          }
  );
  mockCreateConsent.mockResolvedValue({
    url: 'https://accounts.google.com/o/oauth2/v2/auth?state=xyz',
    expiresAt: '2026-01-15T12:10:00.000Z',
  });
  mockVerifyState.mockResolvedValue({ organizationId: ORG_ID, userId: USER_ID });
  mockComplete.mockResolvedValue({ organizationId: ORG_ID, expiresAt: null });
  mockRevoke.mockResolvedValue({ localDeleted: true, remoteRevoked: true });
}

function startReq(headers: Record<string, string> = {}, query = ''): Request {
  return new Request(`http://localhost/api/v1/integrations/google/start${query}`, {
    headers,
  });
}

function callbackReq(query: string): Request {
  return new Request(`http://localhost/api/v1/integrations/google/callback?${query}`);
}

function location(res: Response): string {
  return res.headers.get('location') ?? '';
}

describe('GET /integrations/google/start', () => {
  it('401s without a session', async () => {
    setup();
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await startGET(startReq());
    expect(res.status).toBe(401);
    expect(mockCreateConsent).not.toHaveBeenCalled();
  });

  it('403s when the user has no organization', async () => {
    setup(null);
    const res = await startGET(startReq());
    expect(res.status).toBe(403);
    expect(mockCreateConsent).not.toHaveBeenCalled();
  });

  it('403s for a non-admin role and mints no state', async () => {
    setup('agent');
    const res = await startGET(startReq());
    expect(res.status).toBe(403);
    expect(mockCreateConsent).not.toHaveBeenCalled();
  });

  it('redirects an owner to Google with session-derived org and user', async () => {
    setup('owner');
    const res = await startGET(startReq({ 'x-tenant-id': ORG_ID }));
    expect(res.status).toBe(307);
    expect(location(res)).toContain('accounts.google.com');
    const args = mockCreateConsent.mock.calls[0]?.[1] as {
      organizationId: string;
      userId: string;
      redirectUri: string;
    };
    expect(args.organizationId).toBe(ORG_ID);
    expect(args.userId).toBe(USER_ID);
    expect(args.redirectUri).toBe(
      'http://localhost/api/v1/integrations/google/callback'
    );
  });

  it('503s GOOGLE_NOT_CONFIGURED when the OAuth client is not provisioned', async () => {
    setup('admin');
    mockCreateConsent.mockRejectedValue(await oauthError('CONFIG_MISSING'));
    const res = await startGET(startReq());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('GOOGLE_NOT_CONFIGURED');
  });
});

describe('GET /integrations/google/callback', () => {
  it('bounces a declined consent to settings without touching the session', async () => {
    setup();
    const res = await callbackGET(callbackReq('error=access_denied'));
    expect(res.status).toBe(307);
    expect(location(res)).toContain('/settings/integrations?google=denied');
    expect(mockGetCurrentUser).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('rejects a callback with no code or state', async () => {
    setup();
    const res = await callbackGET(callbackReq(''));
    expect(location(res)).toContain('reason=invalid_callback');
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('401s without a session (the single-use code cannot survive login)', async () => {
    setup();
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await callbackGET(callbackReq('code=c1&state=s1'));
    expect(res.status).toBe(401);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('refuses a tampered state before any exchange', async () => {
    setup();
    mockVerifyState.mockRejectedValue(await oauthError('INVALID_STATE'));
    const res = await callbackGET(callbackReq('code=c1&state=forged'));
    expect(location(res)).toContain('reason=invalid_state');
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('refuses completion by a different user than the state was minted for', async () => {
    setup();
    mockVerifyState.mockResolvedValue({
      organizationId: ORG_ID,
      userId: 'cccccccc-9999-8888-7777-666666666666',
    });
    const res = await callbackGET(callbackReq('code=c1&state=s1'));
    expect(location(res)).toContain('reason=invalid_state');
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('refuses when the session user is not a member of the state organization', async () => {
    setup();
    mockResolveTenantContext.mockResolvedValue(null);
    const res = await callbackGET(callbackReq('code=c1&state=s1'));
    expect(location(res)).toContain('reason=forbidden');
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('refuses a member without the admin role', async () => {
    setup();
    mockResolveTenantContext.mockResolvedValue({
      organizationId: ORG_ID,
      organizationName: 'Panadería La Espiga',
      role: 'viewer',
    });
    const res = await callbackGET(callbackReq('code=c1&state=s1'));
    expect(location(res)).toContain('reason=forbidden');
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('maps a scope refusal to its stable reason', async () => {
    setup();
    mockComplete.mockRejectedValue(await oauthError('SCOPE_NOT_GRANTED'));
    const res = await callbackGET(callbackReq('code=c1&state=s1'));
    expect(location(res)).toContain('reason=scope_not_granted');
  });

  it('connects: verifies membership for the STATE org and completes', async () => {
    setup();
    const res = await callbackGET(callbackReq('code=c1&state=s1'));
    expect(res.status).toBe(307);
    expect(location(res)).toContain('/settings/integrations?google=connected');
    // Membership was resolved against the organization from the signed
    // state, not from any request parameter.
    expect(mockResolveTenantContext).toHaveBeenCalledWith(USER_ID, ORG_ID);
    const args = mockComplete.mock.calls[0]?.[1] as {
      expectedUserId: string;
      code: string;
    };
    expect(args.expectedUserId).toBe(USER_ID);
    expect(args.code).toBe('c1');
  });
});

describe('POST /integrations/google/disconnect', () => {
  function disconnectReq(): Request {
    return new Request('http://localhost/api/v1/integrations/google/disconnect', {
      method: 'POST',
      headers: { 'x-tenant-id': ORG_ID },
    });
  }

  it('401s without a session', async () => {
    setup();
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await disconnectPOST(disconnectReq());
    expect(res.status).toBe(401);
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it('403s for a non-admin role and revokes nothing', async () => {
    setup('manager');
    const res = await disconnectPOST(disconnectReq());
    expect(res.status).toBe(403);
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it('revokes for the session organization and redirects to the revoked state', async () => {
    setup('admin');
    const res = await disconnectPOST(disconnectReq());
    expect(res.status).toBe(303);
    expect(location(res)).toContain('/settings/integrations?google=revoked');
    const args = mockRevoke.mock.calls[0]?.[1] as { organizationId: string };
    expect(args.organizationId).toBe(ORG_ID);
  });

  it('reports disconnect_failed when nothing was deleted', async () => {
    setup('owner');
    mockRevoke.mockResolvedValue({ localDeleted: false, remoteRevoked: false });
    const res = await disconnectPOST(disconnectReq());
    expect(location(res)).toContain('reason=disconnect_failed');
  });
});
