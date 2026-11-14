import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const mocks = vi.hoisted(() => ({
  headers: new Headers(),
  cookies: [] as Array<{ name: string; value: string }>,
  create: vi.fn(),
}));

vi.mock('react', () => ({ cache: <T,>(fn: T) => fn }));
vi.mock('next/headers', () => ({
  headers: async () => mocks.headers,
  cookies: async () => ({
    getAll: () => mocks.cookies,
    get: (n: string) => mocks.cookies.find((c) => c.name === n),
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createAuthenticatedServerClient: mocks.create }));
const resolveTenantContext = vi.fn(async (_u: string, requested?: string | null) => {
  const orgs = [ORG_A, ORG_B].map((id) => ({ organizationId: id, organizationName: id, role: 'owner', locale: 'en' }));
  if (requested) return orgs.find((o) => o.organizationId === requested) ?? null;
  return orgs[0];
});
vi.mock('@tugpt/auth', () => ({
  AuthService: class {
    resolveTenantContext = resolveTenantContext;
  },
}));

import { getSessionContext } from './server';

const session = { name: '__Host-tugpt_session', value: 'opaque' };

describe('getSessionContext', () => {
  beforeEach(() => {
    mocks.headers = new Headers();
    mocks.cookies = [session];
    mocks.create.mockReset();
    mocks.create.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: 'user-1', email: 'u@example.com' } } }) },
    });
    resolveTenantContext.mockClear();
  });

  it('uses the organization forwarded by the proxy in x-tenant-id', async () => {
    mocks.headers = new Headers({ 'x-tenant-id': ORG_B });
    const s = await getSessionContext();
    expect(s?.tenant?.organizationId).toBe(ORG_B);
    expect(s?.requestedTenantRejected).toBe(false);
  });

  it('falls back to the tugpt_tenant_id cookie when no header is forwarded', async () => {
    mocks.headers = new Headers({ cookie: `tugpt_tenant_id=${ORG_B}` });
    expect((await getSessionContext())?.tenant?.organizationId).toBe(ORG_B);
  });

  it('defaults to the first organization without a selection', async () => {
    const s = await getSessionContext();
    expect(s?.tenant?.organizationId).toBe(ORG_A);
    expect(s?.requestedTenantRejected).toBe(false);
  });

  it('flags a non-member selection and renders the default organization', async () => {
    mocks.headers = new Headers({ 'x-tenant-id': '33333333-3333-4333-8333-333333333333' });
    const s = await getSessionContext();
    expect(s?.tenant?.organizationId).toBe(ORG_A);
    expect(s?.requestedTenantRejected).toBe(true);
  });

  it('flags an ambiguous duplicated cookie instead of picking one', async () => {
    mocks.headers = new Headers({ cookie: `tugpt_tenant_id=${ORG_A}; tugpt_tenant_id=${ORG_B}` });
    const s = await getSessionContext();
    expect(s?.requestedTenantRejected).toBe(true);
    expect(resolveTenantContext).not.toHaveBeenCalledWith('user-1', ORG_B);
  });

  it('does not treat legacy Supabase cookies as session authority', async () => {
    mocks.cookies = [{ name: 'sb-ref-auth-token', value: 'legacy' }];
    expect(await getSessionContext()).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('returns null without a session cookie and never queries memberships', async () => {
    mocks.cookies = [];
    expect(await getSessionContext()).toBeNull();
    expect(resolveTenantContext).not.toHaveBeenCalled();
  });

  it('fails closed when the identity transport is unavailable', async () => {
    mocks.create.mockRejectedValue(new Error('private'));
    expect(await getSessionContext()).toBeNull();
  });
});
