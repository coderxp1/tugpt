import { describe, expect, it } from 'vitest';
import { canApproveMcpCalls } from './roles';

describe('canApproveMcpCalls', () => {
  it('allows owners and admins of the active organization', () => {
    expect(canApproveMcpCalls({ requestedTenantRejected: false, tenant: { role: 'owner' } })).toBe(true);
    expect(canApproveMcpCalls({ requestedTenantRejected: false, tenant: { role: 'admin' } })).toBe(true);
  });
  it('refuses members, agents, missing sessions and missing tenants', () => {
    for (const role of ['agent', 'member', 'viewer', '', null]) expect(canApproveMcpCalls({ tenant: { role } }), String(role)).toBe(false);
    expect(canApproveMcpCalls(null)).toBe(false);
    expect(canApproveMcpCalls({ tenant: null })).toBe(false);
  });
  it('refuses when the request selected an organization the person is not a member of', () => {
    expect(canApproveMcpCalls({ requestedTenantRejected: true, tenant: { role: 'owner' } })).toBe(false);
  });
});
