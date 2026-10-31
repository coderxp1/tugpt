import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { classifyRoute, proxy } from './proxy';
import { CONTROL_CENTER_COOKIE, cookieValueFor } from './lib/control-center/access';

// Use vi.hoisted so the mock fn is available when the hoisted vi.mock factory runs
const { mockGetClaims } = vi.hoisted(() => ({
  mockGetClaims: vi.fn(),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getClaims: mockGetClaims,
    },
  })),
}));

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

  /**
   * The Product Control Center is neither public nor tenant-protected: it has
   * its own gate (CONTROL_CENTER_TOKEN). Only the page and its two APIs get
   * that class; anything that merely shares the prefix stays protected.
   */
  it('classifies the Control Center routes as operator, and nothing else', () => {
    expect(classifyRoute('/control-center')).toBe('operator');
    expect(classifyRoute('/api/v1/control-center/health')).toBe('operator');
    expect(classifyRoute('/api/v1/control-center/lab')).toBe('operator');
    expect(classifyRoute('/control-centerx')).toBe('protected');
    expect(classifyRoute('/control-center/anything')).toBe('protected');
    expect(classifyRoute('/api/v1/control-centerx')).toBe('protected');
  });
});

describe('Control Center operator gate', () => {
  const TOKEN = 'test-owner-secret-0123456789abcdef';
  beforeEach(() => { mockGetClaims.mockReset(); delete process.env.CONTROL_CENTER_TOKEN; });
  afterEach(() => { vi.unstubAllEnvs(); delete process.env.CONTROL_CENTER_TOKEN; });
  it.each(['development', 'production'])('returns 404 without configuration in %s', async (env) => {
    vi.stubEnv('NODE_ENV', env);
    for (const path of ['/control-center', '/api/v1/control-center/health', '/api/v1/control-center/lab']) {
      expect((await proxy(new NextRequest('http://localhost' + path))).status).toBe(404);
    }
    expect(mockGetClaims).not.toHaveBeenCalled();
  });
  it('provides an owner unlock screen, not a tenant login redirect', async () => {
    process.env.CONTROL_CENTER_TOKEN = TOKEN;
    const page = await proxy(new NextRequest('http://localhost/control-center'));
    expect(page.status).toBe(401);
    expect(page.headers.get('location')).toBeNull();
    expect(await page.text()).toContain('Owner access key');
    const api = await proxy(new NextRequest('http://localhost/api/v1/control-center/health'));
    expect(api.status).toBe(401);
    expect(await api.json()).toMatchObject({ error: 'Unauthenticated' });
  });
  it('never accepts URL credentials or raw keys in cookies', async () => {
    process.env.CONTROL_CENTER_TOKEN = TOKEN;
    expect((await proxy(new NextRequest(`http://localhost/control-center?key=${TOKEN}`))).status).toBe(401);
    expect((await proxy(new NextRequest('http://localhost/control-center', { headers: { cookie: `${CONTROL_CENTER_COOKIE}=${TOKEN}` } }))).status).toBe(401);
  });
  it('unlocks by header and sets a secure httpOnly session on HTTPS', async () => {
    process.env.CONTROL_CENTER_TOKEN = TOKEN;
    const res = await proxy(new NextRequest('https://example.test/api/v1/control-center/health', { headers: { 'x-control-center-key': TOKEN } }));
    expect(res.status).toBe(200);
    const cookie = res.cookies.get(CONTROL_CENTER_COOKIE)!;
    expect(cookie.value).toMatch(/^\d{10}\.[a-f0-9]{64}$/);
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', maxAge: 43200 });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const follow = await proxy(new NextRequest('https://example.test/control-center', { headers: { cookie: `${CONTROL_CENTER_COOKIE}=${cookie.value}` } }));
    expect(follow.status).toBe(200);
    expect(follow.headers.get('cache-control')).toBe('no-store');
    expect(follow.headers.get('referrer-policy')).toBe('same-origin');
    expect(mockGetClaims).not.toHaveBeenCalled();
  });
  it('rejects expired sessions and cross-origin requests', async () => {
    process.env.CONTROL_CENTER_TOKEN = TOKEN;
    const expired = await cookieValueFor(TOKEN, Date.now() - 43201000);
    expect((await proxy(new NextRequest('http://localhost/control-center', { headers: { cookie: `${CONTROL_CENTER_COOKIE}=${expired}` } }))).status).toBe(401);
    expect((await proxy(new NextRequest('http://localhost/api/v1/control-center/lab', { method: 'POST', headers: { origin: 'https://evil.test', 'x-control-center-key': TOKEN } }))).status).toBe(403);
  });
  it('locks the workspace by clearing the browser session', async () => {
    process.env.CONTROL_CENTER_TOKEN = TOKEN;
    const res = await proxy(new NextRequest('http://localhost/control-center?logout=1', { method: 'POST', headers: { origin: 'http://localhost', cookie: `${CONTROL_CENTER_COOKIE}=${await cookieValueFor(TOKEN)}` } }));
    expect(res.status).toBe(303);
    expect(res.cookies.get(CONTROL_CENTER_COOKIE)?.maxAge).toBe(0);
    expect(res.headers.get('location')).toBe('http://localhost/control-center');
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
      headers: { cookie: 'sb-access-token=valid-token' },
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
  it('leaves the WhatsApp webhook path to its own HMAC check', async () => {
    const req = new NextRequest('http://localhost/api/v1/webhooks/whatsapp', { method: 'POST' });
    const res = await proxy(req);

    expect(res.status).toBe(200);
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

    expect(mockGetClaims).not.toHaveBeenCalled();
  });
});
