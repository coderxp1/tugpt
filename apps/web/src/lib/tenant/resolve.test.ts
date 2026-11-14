import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@tugpt/auth';
import { normalizeRequestedTenantId, resolveSessionTenant, type TenantResolver } from './resolve';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ORG_FOREIGN = '33333333-3333-4333-8333-333333333333';

const ctx = (organizationId: string, organizationName: string): TenantContext => ({
  organizationId,
  organizationName,
  role: 'owner',
  locale: 'es',
});

/** Mirrors AuthService.resolveTenantContext: membership-checked, first org by default. */
function resolverFor(orgs: TenantContext[]) {
  const resolveTenantContext = vi.fn(async (_userId: string, requested?: string | null) => {
    if (orgs.length === 0) return null;
    if (requested) return orgs.find((o) => o.organizationId === requested) ?? null;
    return orgs[0];
  });
  return { resolveTenantContext } satisfies TenantResolver;
}

describe('normalizeRequestedTenantId', () => {
  it('accepts UUIDs and lower-cases them', () => {
    expect(normalizeRequestedTenantId(` ${ORG_A.toUpperCase()} `)).toBe(ORG_A);
  });
  it.each([null, undefined, '', '   ', 'org-1', "x' OR 1=1 --", `${ORG_A},${ORG_B}`])(
    'rejects %j',
    (raw) => expect(normalizeRequestedTenantId(raw as string | null | undefined)).toBeNull(),
  );
});

describe('resolveSessionTenant', () => {
  const both = [ctx(ORG_A, 'Org A'), ctx(ORG_B, 'Org B')];

  it('honors the selected organization when the user is a member (regression: used to render the first org)', async () => {
    const r = resolverFor(both);
    const out = await resolveSessionTenant(r, 'user-1', ORG_B);
    expect(out.tenant?.organizationId).toBe(ORG_B);
    expect(out.requestedTenantRejected).toBe(false);
    expect(r.resolveTenantContext).toHaveBeenCalledWith('user-1', ORG_B);
  });

  it('falls back to the default and flags rejection for a non-member organization', async () => {
    const out = await resolveSessionTenant(resolverFor(both), 'user-1', ORG_FOREIGN);
    expect(out.tenant?.organizationId).toBe(ORG_A);
    expect(out.requestedTenantRejected).toBe(true);
  });

  it('never returns the foreign organization even if it is the only one requested', async () => {
    const out = await resolveSessionTenant(resolverFor([ctx(ORG_A, 'Org A')]), 'user-1', ORG_FOREIGN);
    expect(out.tenant?.organizationId).not.toBe(ORG_FOREIGN);
  });

  it('uses the default organization when nothing is selected', async () => {
    const r = resolverFor(both);
    const out = await resolveSessionTenant(r, 'user-1', null);
    expect(out).toEqual({ tenant: both[0], requestedTenantRejected: false });
    expect(r.resolveTenantContext).toHaveBeenCalledTimes(1);
  });

  it('does not send malformed selections to the resolver and flags them', async () => {
    const r = resolverFor(both);
    const out = await resolveSessionTenant(r, 'user-1', 'not-a-uuid');
    expect(out.tenant?.organizationId).toBe(ORG_A);
    expect(out.requestedTenantRejected).toBe(true);
    expect(r.resolveTenantContext).toHaveBeenCalledTimes(1);
    expect(r.resolveTenantContext).toHaveBeenCalledWith('user-1');
  });

  it('returns null tenant for users with no organization', async () => {
    const out = await resolveSessionTenant(resolverFor([]), 'user-1', ORG_A);
    expect(out.tenant).toBeNull();
  });
});
