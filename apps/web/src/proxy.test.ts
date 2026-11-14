import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { classifyRoute, proxy } from './proxy';

// Use vi.hoisted so the mock fn is available when the hoisted vi.mock factory runs
const { mockGetClaims } = vi.hoisted(() => ({
  mockGetClaims: vi.fn(),
}));

vi.mock('@/lib/sso/core', () => ({ safeHeaders: { 'Cache-Control': 'no-store' }, loadSession: async () => { const result = await mockGetClaims(); return result?.error ? null : result?.data; } }));

// Mock @tugpt/database to provide the Database type
vi.mock('@tugpt/database', () => ({
  Database: {},
}));

describe('Next.js 16 Proxy Route Classifier', () => {
  it('classifies /auth paths as auth routes', () => {
    expect(classifyRoute('/auth/login')).toBe('auth');
    expect(classifyRoute('/auth/callback')).toBe('auth');
    expect(classifyRoute('/auth/logout')).toBe('auth');
    expect(classifyRoute('/api/v1/auth/session')).toBe('auth');
  });

  it('classifies application pages as protected routes', () => {
    expect(classifyRoute('/dashboard')).toBe('protected');
    expect(classifyRoute('/dashboard/drafts')).toBe('protected');
    expect(classifyRoute('/dashboard/drafts/[draftId]')).toBe('protected');
    expect(classifyRoute('/settings')).toBe('protected');
    expect(classifyRoute('/crm')).toBe('protected');
    expect(classifyRoute('/organizations')).toBe('protected');
  });

  it('classifies only the enumerated exceptions as public', () => {
    expect(classifyRoute('/')).toBe('public');
    expect(classifyRoute('/api/v1/health')).toBe('public');
    expect(classifyRoute('/api/v1/webhooks/whatsapp')).toBe('public');
    expect(classifyRoute('/api/v1/organizations')).toBe('public');
    expect(classifyRoute('/api/v1/drafts')).toBe('public');
    expect(classifyRoute('/api/v1/drafts/abc-123')).toBe('public');
    expect(classifyRoute('/api/v1/drafts/abc-123/approve')).toBe('public');
  });

  /**
   * The reason this change exists. classifyRoute used to be an allowlist of
   * protected prefixes with a `public` fallback, so a page added at a path
   * nobody remembered to list was served with no authentication check at all.
   * `/about` and `/pricing` were asserted to be public by the previous version
   * of this test — which documented the hole rather than closing it.
   */
  it('treats an unlisted path as protected, not public', () => {
    expect(classifyRoute('/about')).toBe('protected');
    expect(classifyRoute('/pricing')).toBe('protected');
    expect(classifyRoute('/reports')).toBe('protected');
    expect(classifyRoute('/admin/users')).toBe('protected');
    expect(classifyRoute('/api/v1/anything-new')).toBe('protected');
  });

  /**
   * Prefix matching is a segment boundary, not `startsWith`. The old classifier
   * would have called `/authorize-payments` an auth route.
   */
  it('matches prefixes on segment boundaries only', () => {
    expect(classifyRoute('/authorize-payments')).toBe('protected');
    expect(classifyRoute('/authx')).toBe('protected');
    expect(classifyRoute('/api/v1/draftsomething')).toBe('protected');
    expect(classifyRoute('/api/v1/organizations-export')).toBe('protected');
    expect(classifyRoute('/api/v1/webhooksomething')).toBe('protected');
  });
});

describe('Next.js 16 Proxy Execution', () => {
  beforeEach(() => {
    mockGetClaims.mockReset();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
  });

  it('redirects unauthenticated users from protected pages to login', async () => {
    mockGetClaims.mockResolvedValueOnce({ data: null, error: { message: 'no session' } });

    const req = new NextRequest('http://localhost/dashboard');
    const res = await proxy(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/auth/login?redirect=%2Fdashboard');
  });

  /**
   * A `fetch()` for JSON must not be answered with a redirect to an HTML login
   * page: following it yields a 200 with a `<!DOCTYPE html>` body, so the
   * caller's `res.json()` throws a parse error instead of seeing the 401 that
   * actually happened.
   */
  it('answers an unauthenticated API request with 401 JSON, not a redirect', async () => {
    mockGetClaims.mockResolvedValueOnce({ data: null, error: { message: 'no session' } });

    const req = new NextRequest('http://localhost/api/v1/anything-new');
    const res = await proxy(req);

    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
    await expect(res.json()).resolves.toEqual({ error: 'Unauthenticated' });
  });

  it('allows authenticated users with valid claims to access protected routes', async () => {
    mockGetClaims.mockResolvedValueOnce({
      data: {
        claims: { sub: 'user-1', email: 'test@example.com', aud: 'authenticated' },
        header: {},
        signature: new Uint8Array(),
      },
    });

    const req = new NextRequest('http://localhost/dashboard', {
      headers: { cookie: '__Host-tugpt_session=' + 's'.repeat(43) },
    });
    const res = await proxy(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toMatch(/^req-/);
  });

  /**
   * The container healthcheck in docker-compose.yml polls this with no
   * credentials, and `wget` follows redirects — so if this ever became
   * protected, the healthcheck would follow the 307 to the login page, get a
   * 200, and report a dead app as healthy. It must stay reachable, and the
   * session check must not run for it.
   */
  it('serves the liveness probe without consulting the session', async () => {
    const req = new NextRequest('http://localhost/api/v1/health');
    const res = await proxy(req);

    expect(res.status).toBe(200);
    expect(mockGetClaims).not.toHaveBeenCalled();
  });

  /**
   * Meta calls this unauthenticated. If the proxy ever gated it, every inbound
   * webhook would be answered with a redirect and no message would arrive.
   */
  it('keeps the privileged WhatsApp webhook on hold before any authentication', async () => {
    const req = new NextRequest('http://localhost/api/v1/webhooks/whatsapp', { method: 'POST' });
    const res = await proxy(req);

    expect(res.status).toBe(503);
    expect(mockGetClaims).not.toHaveBeenCalled();
  });

  it('injects x-request-id and propagates x-tenant-id header when cookie is present', async () => {
    const req = new NextRequest('http://localhost/api/v1/health', {
      headers: {
        'x-request-id': 'custom-req-id-123',
        cookie: 'tugpt_tenant_id=org-uuid-456',
      },
    });
    const res = await proxy(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('custom-req-id-123');
    expect(res.headers.get('x-tenant-id')).toBe('org-uuid-456');
  });

  it('propagates x-tenant-id header when cookie is absent but header is present', async () => {
    const req = new NextRequest('http://localhost/api/v1/health', {
      headers: {
        'x-request-id': 'custom-req-id-789',
        'x-tenant-id': 'org-uuid-789',
      },
    });
    const res = await proxy(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('custom-req-id-789');
    expect(res.headers.get('x-tenant-id')).toBe('org-uuid-789');
  });

  /**
   * The proxy does NOT strip or validate a client-supplied x-tenant-id; it
   * only chooses which REQUEST to forward. Authorization happens in the
   * handlers, which check membership with AuthService.resolveTenantContext
   * and answer 403 for a non-member org (google-oauth-org-isolation.test.ts,
   * routes.test.ts). This pins the precedence so a client header can never
   * override the organization the user selected in the switcher.
   */
  it('prefers the switcher cookie over a conflicting client-supplied x-tenant-id', async () => {
    const req = new NextRequest('http://localhost/api/v1/health', {
      headers: {
        cookie: 'tugpt_tenant_id=org-from-cookie',
        'x-tenant-id': 'org-from-forged-header',
      },
    });
    const res = await proxy(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('x-tenant-id')).toBe('org-from-cookie');
  });

  /**
   * A web image built without the NEXT_PUBLIC_* build args has no Supabase
   * config at all. That used to bounce every dashboard request to the login
   * page forever, which reads like an authentication bug rather than a build
   * one. It still refuses — but an API caller now gets a 401 it can act on.
   */
  it('refuses protected routes when Supabase env is missing, in the caller\'s own shape', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    const page = await proxy(new NextRequest('http://localhost/dashboard'));
    expect(page.status).toBe(307);
    expect(page.headers.get('location')).toBe('http://localhost/auth/login?redirect=%2Fdashboard');

    const api = await proxy(new NextRequest('http://localhost/api/v1/anything-new'));
    expect(api.status).toBe(401);
    await expect(api.json()).resolves.toEqual({ error: 'Unauthenticated' });

    expect(mockGetClaims).toHaveBeenCalledTimes(2);
  });
});

it('refuses a session-store outage without pretending the visitor is logged out', async () => {
  mockGetClaims.mockRejectedValue(new Error('private outage detail'));
  for (const path of ['/dashboard', '/api/v1/anything-new']) {
    const response = await proxy(new NextRequest('https://dashboard.example' + path));
    expect(response.status).toBe(503); expect(response.headers.get('location')).toBeNull();
    expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
  }
});
