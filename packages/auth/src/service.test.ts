import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './service';
import type { TypedSupabaseClient } from '@tugpt/database';

function createMockSupabase(memberships: Array<{
  organization_id: string;
  role: 'owner' | 'admin' | 'manager' | 'agent' | 'viewer';
  created_at?: string | null;
  // `locale` is optional here on purpose: most of these fixtures do not care
  // about it, and a row that omits it exercises the same coercion path as a row
  // holding something the CHECK constraint should have refused.
  organizations: {
    id: string;
    name: string;
    locale?: unknown;
    deleted_at: string | null;
  } | null;
}>) {
  const memberSelect = vi.fn().mockReturnThis();

  return {
    // Exposed so a test can assert what the membership query asks PostgREST
    // for. See "asks the database for the locale column".
    __memberSelect: memberSelect,
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: 'user-1', email: 'user@example.com', user_metadata: {} } },
        error: null,
      }),
      signInWithOAuth: vi.fn(),
      signUp: vi.fn(),
      signInWithPassword: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      updateUser: vi.fn(),
      refreshSession: vi.fn(),
      signOut: vi.fn(),
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'organization_members') {
        return {
          select: memberSelect,
          eq: vi.fn().mockResolvedValue({
            data: memberships,
            error: null,
          }),
        };
      }
      if (table === 'profiles') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: {
              id: 'user-1',
              email: 'user@example.com',
              full_name: 'Test User',
              avatar_url: null,
            },
            error: null,
          }),
        };
      }
      return {};
    }),
  } as unknown as TypedSupabaseClient;
}

describe('AuthService Multi-Tenant Context Resolution', () => {
  it('resolves requested tenant when user is an active member', async () => {
    const supabase = createMockSupabase([
      {
        organization_id: 'org-1',
        role: 'owner',
        organizations: { id: 'org-1', name: 'Org One', deleted_at: null },
      },
      {
        organization_id: 'org-2',
        role: 'agent',
        organizations: { id: 'org-2', name: 'Org Two', deleted_at: null },
      },
    ]);

    const service = new AuthService(supabase);
    const tenant = await service.resolveTenantContext('user-1', 'org-2');

    expect(tenant).not.toBeNull();
    expect(tenant?.organizationId).toBe('org-2');
    expect(tenant?.organizationName).toBe('Org Two');
    expect(tenant?.role).toBe('agent');
  });

  it('returns null when requested tenant is not in user active memberships', async () => {
    const supabase = createMockSupabase([
      {
        organization_id: 'org-1',
        role: 'owner',
        organizations: { id: 'org-1', name: 'Org One', deleted_at: null },
      },
    ]);

    const service = new AuthService(supabase);
    const tenant = await service.resolveTenantContext('user-1', 'org-unauthorized');

    expect(tenant).toBeNull();
  });

  it('filters out soft-deleted organizations (deleted_at IS NOT NULL)', async () => {
    const supabase = createMockSupabase([
      {
        organization_id: 'org-deleted',
        role: 'owner',
        organizations: { id: 'org-deleted', name: 'Deleted Org', deleted_at: '2026-07-01T00:00:00Z' },
      },
      {
        organization_id: 'org-active',
        role: 'admin',
        organizations: { id: 'org-active', name: 'Active Org', deleted_at: null },
      },
    ]);

    const service = new AuthService(supabase);
    const orgs = await service.getUserOrganizations('user-1');

    expect(orgs).toHaveLength(1);
    expect(orgs[0].organizationId).toBe('org-active');

    // Requesting soft-deleted org returns null
    const deletedContext = await service.resolveTenantContext('user-1', 'org-deleted');
    expect(deletedContext).toBeNull();
  });

  it('defaults to first active organization when requestedTenantId is omitted', async () => {
    const supabase = createMockSupabase([
      {
        organization_id: 'org-default',
        role: 'owner',
        organizations: { id: 'org-default', name: 'Default Org', deleted_at: null },
      },
      {
        organization_id: 'org-secondary',
        role: 'viewer',
        organizations: { id: 'org-secondary', name: 'Secondary Org', deleted_at: null },
      },
    ]);

    const service = new AuthService(supabase);
    const tenant = await service.resolveTenantContext('user-1');

    expect(tenant).not.toBeNull();
    expect(tenant?.organizationId).toBe('org-default');
  });

  it('returns null if user has no active organization memberships', async () => {
    const supabase = createMockSupabase([]);

    const service = new AuthService(supabase);
    const tenant = await service.resolveTenantContext('user-1');

    expect(tenant).toBeNull();
  });
});

describe('AuthService locale resolution', () => {
  it('carries the organization locale into the tenant context', async () => {
    // The dashboard's language comes from here (ADR-017). It rides on the
    // membership row that already had to be read to answer "which organization
    // is this?", so there is one answer rather than two that can disagree.
    const supabase = createMockSupabase([
      {
        organization_id: 'org-en',
        role: 'owner',
        organizations: { id: 'org-en', name: 'English Org', locale: 'en', deleted_at: null },
      },
    ]);
    const service = new AuthService(supabase);

    const tenant = await service.resolveTenantContext('user-1');

    expect(tenant?.locale).toBe('en');
  });

  it('falls back to Spanish for a locale the dashboard cannot render', async () => {
    // The constraint added in 20260830000001 should make this unreachable. It is
    // tested because the alternative at this boundary is a layout rendering
    // `undefined`, and Spanish is a complete answer for every organization that
    // exists.
    const supabase = createMockSupabase([
      {
        organization_id: 'org-odd',
        role: 'owner',
        organizations: { id: 'org-odd', name: 'Odd Org', locale: 'pt-BR', deleted_at: null },
      },
    ]);
    const service = new AuthService(supabase);

    expect((await service.resolveTenantContext('user-1'))?.locale).toBe('es');
  });

  it('asks the database for the locale column', async () => {
    // The one mutation this suite could not otherwise catch. Dropping `locale`
    // from the select makes every organization render Spanish — which is the
    // default, so nothing looks wrong, in staging or in production, until an
    // English customer says the dashboard ignores their setting.
    const supabase = createMockSupabase([]);
    await new AuthService(supabase).getUserOrganizations('user-1');

    const select = (supabase as unknown as { __memberSelect: { mock: { calls: string[][] } } })
      .__memberSelect;
    expect(select.mock.calls[0][0]).toContain('locale');
  });

  it('falls back to Spanish when the column is absent from the row', async () => {
    const supabase = createMockSupabase([
      {
        organization_id: 'org-old',
        role: 'owner',
        organizations: { id: 'org-old', name: 'Old Org', deleted_at: null },
      },
    ]);
    const service = new AuthService(supabase);

    expect((await service.resolveTenantContext('user-1'))?.locale).toBe('es');
  });
});

describe('AuthService deterministic active organization', () => {
  const org = (id: string, created_at?: string | null) => ({
    organization_id: id,
    role: 'agent' as const,
    created_at,
    organizations: { id, name: id, deleted_at: null },
  });

  it('asks the database for membership created_at', async () => {
    const supabase = createMockSupabase([]);
    await new AuthService(supabase).getUserOrganizations('user-1');
    const select = (supabase as unknown as { __memberSelect: { mock: { calls: string[][] } } })
      .__memberSelect;
    expect(select.mock.calls[0][0]).toContain('created_at');
  });

  it('defaults to the oldest membership regardless of returned row order', async () => {
    const rows = [
      org('org-c', '2026-03-01T00:00:00Z'),
      org('org-a', '2026-02-01T00:00:00Z'),
      org('org-b', '2026-01-01T00:00:00Z'),
    ];
    for (const order of [rows, [...rows].reverse(), [rows[1], rows[2], rows[0]]]) {
      const service = new AuthService(createMockSupabase(order));
      expect((await service.resolveTenantContext('user-1'))?.organizationId).toBe('org-b');
      expect((await service.getUserOrganizations('user-1')).map((o) => o.organizationId)).toEqual([
        'org-b',
        'org-a',
        'org-c',
      ]);
    }
  });

  it('breaks created_at ties by organization id and puts missing timestamps last', async () => {
    const ts = '2026-01-01T00:00:00Z';
    const service = new AuthService(
      createMockSupabase([org('org-z', null), org('org-y', ts), org('org-x', ts), org('org-w', 'garbage')])
    );
    expect((await service.getUserOrganizations('user-1')).map((o) => o.organizationId)).toEqual([
      'org-x',
      'org-y',
      'org-w',
      'org-z',
    ]);
  });

  it('an explicitly requested tenant still wins over the default', async () => {
    const service = new AuthService(
      createMockSupabase([org('org-old', '2025-01-01T00:00:00Z'), org('org-new', '2026-01-01T00:00:00Z')])
    );
    expect((await service.resolveTenantContext('user-1', 'org-new'))?.organizationId).toBe('org-new');
  });
});
