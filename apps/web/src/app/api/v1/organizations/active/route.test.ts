import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
const mocks = vi.hoisted(() => ({ user: vi.fn(), tenant: vi.fn(), orgs: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createAuthenticatedServerClient: vi.fn(async () => ({})) }));
vi.mock('@tugpt/auth', () => ({ AuthService: vi.fn().mockImplementation(function () { return { getCurrentUser: mocks.user, resolveTenantContext: mocks.tenant, getUserOrganizations: mocks.orgs }; }) }));
const id = '11111111-1111-4111-8111-111111111111';
const tenant = { organizationId: id, organizationName: 'Test', role: 'owner', locale: 'en' };
function req(body: unknown = { organizationId: id }, headers: Record<string,string> = {}) {
  return new Request('https://staging.example/api/v1/organizations/active', { method: 'POST', headers: { origin: 'https://staging.example', 'content-type': 'application/json', 'x-tugpt-csrf': '1', ...headers }, body: JSON.stringify(body) });
}
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => { vi.stubEnv('TUGPT_APP_ORIGIN', 'https://staging.example'); vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: 'user' }); mocks.tenant.mockResolvedValue(tenant); mocks.orgs.mockResolvedValue([tenant]); });
describe('active organization', () => {
  it('sets only a membership-validated, httpOnly selection', async () => { const r = await POST(req()); expect(r.status).toBe(200); expect(r.headers.get('set-cookie')).toContain('HttpOnly'); expect(r.headers.get('set-cookie')).toContain('Secure'); expect(mocks.tenant).toHaveBeenCalledWith('user', id); });
  it('rejects unauthenticated selection', async () => { mocks.user.mockResolvedValue(null); expect((await POST(req())).status).toBe(401); });
  it('rejects nonmembers/revoked membership without setting a cookie', async () => { mocks.tenant.mockResolvedValue(null); const r = await POST(req()); expect(r.status).toBe(403); expect(r.headers.get('set-cookie')).toBeNull(); });
  it.each<Record<string,string>>([{ origin: 'https://evil.example' }, { 'x-tugpt-csrf': '' }, { 'content-type': 'text/plain' }, { 'sec-fetch-site': 'cross-site' }])('rejects CSRF before resolving identity: %j', async headers => { expect((await POST(req(undefined, headers))).status).toBe(403); expect(mocks.user).not.toHaveBeenCalled(); });
  it.each([null, [], { organizationId: '' }, { organizationId: 'bad' }])('rejects malformed payload %j', async body => { expect((await POST(req(body))).status).toBe(400); });
  it('bounds request size', async () => { expect((await POST(req({ organizationId: id, extra: 'x'.repeat(17000) }))).status).toBe(400); });
  it('can list valid choices independently of stale tenant selection', async () => { expect((await GET()).status).toBe(200); expect(mocks.tenant).not.toHaveBeenCalled(); });
  it('requires authentication to list choices', async () => { mocks.user.mockResolvedValue(null); expect((await GET()).status).toBe(401); });
  it('redacts dependency failures', async () => { mocks.tenant.mockRejectedValue(new Error('secret')); const r = await POST(req()); expect(r.status).toBe(503); expect(await r.text()).not.toContain('secret'); });
});

it('rejects unknown fields without changing selection', async () => {
  const response = await POST(req({ organizationId: id, role: 'owner' }));
  expect(response.status).toBe(400); expect(response.headers.get('set-cookie')).toBeNull();
});
it('fails closed if the public origin is missing', async () => {
  vi.stubEnv('TUGPT_APP_ORIGIN', '');
  expect((await POST(req())).status).toBe(403); expect(mocks.user).not.toHaveBeenCalled();
});
