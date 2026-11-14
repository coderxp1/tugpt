import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { GET as sessionGET } from './auth/session/route';
import { GET as orgsGET, POST as orgsPOST } from './organizations/route';

const mockRpc = vi.fn();

// Mock the cookie-aware server client used by all routes
vi.mock('@/lib/supabase/server', () => ({
  createAuthenticatedServerClient: vi.fn(() =>
    Promise.resolve({
      rpc: mockRpc,
    })
  ),
}));

// Still mock @tugpt/database for createAdminSupabaseClient (used in drafts routes)
vi.mock('@tugpt/database', () => ({
  createAdminSupabaseClient: vi.fn(() => ({
    rpc: vi.fn(),
  })),
}));

const mockGetCurrentUser = vi.fn();
const mockGetUserOrganizations = vi.fn();
const mockResolveTenantContext = vi.fn();

vi.mock('@tugpt/auth', () => {
  return {
    AuthService: vi.fn().mockImplementation(function () {
      return {
        getCurrentUser: mockGetCurrentUser,
        getUserOrganizations: mockGetUserOrganizations,
        resolveTenantContext: mockResolveTenantContext,
      };
    }),
  };
});

describe('API v1 Auth Session Route', () => {
  it('returns 401 when user is unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null);

    const req = new Request('http://localhost/api/v1/auth/session');
    const res = await sessionGET(req);
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.authenticated).toBe(false);
    expect(data.user).toBeNull();
  });

  it('returns authenticated user session and validated active tenant', async () => {
    mockGetCurrentUser.mockResolvedValueOnce({
      id: 'user-1',
      email: 'user@example.com',
      fullName: 'Test User',
      avatarUrl: null,
    });
    mockResolveTenantContext.mockResolvedValueOnce({
      organizationId: 'org-1',
      organizationName: 'Test Org',
      role: 'owner',
    });

    const req = new Request('http://localhost/api/v1/auth/session', {
      headers: { 'x-tenant-id': 'org-1' },
    });
    const res = await sessionGET(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.authenticated).toBe(true);
    expect(data.user.id).toBe('user-1');
    expect(data.activeTenant.organizationId).toBe('org-1');
  });
});

describe('API v1 Organizations Route', () => {
  it('returns 401 when listing organizations unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null);

    const req = new Request('http://localhost/api/v1/organizations');
    const res = await orgsGET(req);

    expect(res.status).toBe(401);
  });

  it('returns 403 when client passes illegal x-tenant-id header user does not belong to', async () => {
    mockGetCurrentUser.mockResolvedValueOnce({ id: 'user-1' });
    mockResolveTenantContext.mockResolvedValueOnce(null); // Access denied

    const req = new Request('http://localhost/api/v1/organizations', {
      headers: { 'x-tenant-id': 'unauthorized-org-999' },
    });
    const res = await orgsGET(req);
    const data = await res.json();

    expect(res.status).toBe(403);
    expect(data.error).toContain('Access denied');
  });

  it('returns 200 with active tenant and organizations list for authorized user', async () => {
    const mockUser = { id: 'user-1', email: 'user@example.com' };
    const mockTenant = { organizationId: 'org-1', organizationName: 'Org One', role: 'owner' };
    const mockOrgsList = [mockTenant];

    mockGetCurrentUser.mockResolvedValueOnce(mockUser);
    mockResolveTenantContext.mockResolvedValueOnce(mockTenant);
    mockGetUserOrganizations.mockResolvedValueOnce(mockOrgsList);

    const req = new Request('http://localhost/api/v1/organizations', {
      headers: { 'x-tenant-id': 'org-1' },
    });
    const res = await orgsGET(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.organizations).toHaveLength(1);
    expect(data.activeTenant.organizationId).toBe('org-1');
    expect(data.total).toBe(1);
  });

  it('returns 401 when creating organization unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null);

    const req = new Request('http://localhost/api/v1/organizations', {
      method: 'POST',
      headers: { origin: 'https://dashboard.example', 'x-tugpt-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New Org', slug: 'new-org' }),
    });
    const res = await orgsPOST(req);

    expect(res.status).toBe(401);
  });

  it('returns 400 when creating organization with missing fields', async () => {
    mockGetCurrentUser.mockResolvedValueOnce({ id: 'user-1' });

    const req = new Request('http://localhost/api/v1/organizations', {
      method: 'POST',
      headers: { origin: 'https://dashboard.example', 'x-tugpt-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Only Name' }),
    });
    const res = await orgsPOST(req);

    expect(res.status).toBe(400);
  });

  it('successfully creates organization via create_organization_with_owner RPC', async () => {
    mockGetCurrentUser.mockResolvedValueOnce({ id: 'user-1' });
    mockRpc.mockResolvedValueOnce({ data: 'created-org-id-123', error: null });

    const req = new Request('http://localhost/api/v1/organizations', {
      method: 'POST',
      headers: { origin: 'https://dashboard.example', 'x-tugpt-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Acme Corp', slug: 'acme-corp' }),
    });
    const res = await orgsPOST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.organization.id).toBe('created-org-id-123');
    expect(data.organization.name).toBe('Acme Corp');
    expect(data.organization.slug).toBe('acme-corp');
    expect(mockRpc).toHaveBeenCalledWith('create_organization_with_owner', {
      p_name: 'Acme Corp',
      p_slug: 'acme-corp',
      p_owner_id: 'user-1',
    });
  });
});
// Synthetic unit fixture only; no host or network configuration is changed.
beforeEach(() => vi.stubEnv('TUGPT_APP_ORIGIN', 'https://dashboard.example'));
afterEach(() => vi.unstubAllEnvs());
