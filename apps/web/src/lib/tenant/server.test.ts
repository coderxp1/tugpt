import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const state = {
  headers: new Map<string, string>(),
  cookies: [] as Array<{ name: string; value: string }>,
};

vi.mock('react', () => ({ cache: <T,>(fn: T) => fn }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (k: string) => state.headers.get(k) ?? null }),
  cookies: async () => ({
    getAll: () => state.cookies,
    get: (n: string) => state.cookies.find((c) => c.name === n),
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createAuthenticatedServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1', email: 'u@example.com' } } }) },
  }),
}));
const resolveTenantContext = vi.fn(async (_u: string, requested?: string | null) => {
  const orgs = [ORG_A, ORG_B].map((id) => ({ organizationId: id, organizationName: id, role: 'owner', locale: 'es' }));
  if (requested) return orgs.find((o) => o.organizationId === requested) ?? null;
  return orgs[0];
});
vi.mock('@tugpt/auth', () => ({
  AuthService: class {
    resolveTenantContext = resolveTenantContext;
  },
}));

const session = { name: 'sb-ref-auth-token', value: 'x' };

describe('getSessionContext active organization', () => {
  beforeEach(() => {
    state.headers.clear();
    state.cookies = [session];
    resolveTenantContext.mockClear();
  });

  it('uses the organization forwarded by the proxy in x-tenant-id', async () => {
    state.headers.set('x-tenant-id', ORG_B);
    const { getSessionContext } = await import('./server');
    const s = await getSessionContext();
    expect(s?.tenant?.organizationId).toBe(ORG_B);
    expect(s?.requestedTenantRejected).toBe(false);
  });

  it('falls back to the tugpt_tenant_id cookie when no header is forwarded', async () => {
    state.cookies = [session, { name: 'tugpt_tenant_id', value: ORG_B }];
    const { getSessionContext } = await import('./server');
    expect((await getSessionContext())?.tenant?.organizationId).toBe(ORG_B);
  });

  it('defaults to the first organization without a selection', async () => {
    const { getSessionContext } = await import('./server');
    const s = await getSessionContext();
    expect(s?.tenant?.organizationId).toBe(ORG_A);
    expect(s?.requestedTenantRejected).toBe(false);
  });

  it('returns null without a session cookie and never queries memberships', async () => {
    state.cookies = [];
    const { getSessionContext } = await import('./server');
    expect(await getSessionContext()).toBeNull();
    expect(resolveTenantContext).not.toHaveBeenCalled();
  });
});
