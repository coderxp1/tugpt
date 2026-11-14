import { describe, expect, it } from 'vitest';
import { getRequestedTenantId } from './request';
describe('canonical requested organization', () => {
  it('has no implicit hint when no selection exists', () => expect(getRequestedTenantId(new Headers())).toBeNull());
  it('uses the persisted browser selection', () => expect(getRequestedTenantId(new Headers({ cookie: 'a=1; tugpt_tenant_id=org-b' }))).toBe('org-b'));
  it('uses the explicit request consistently over the browser cookie', () => expect(getRequestedTenantId(new Headers({ cookie: 'tugpt_tenant_id=org-a', 'x-tenant-id': 'org-b' }))).toBe('org-b'));
  it.each(['', 'org-a,org-b', 'bad tenant'])('does not fall back on an invalid explicit header %j', value => expect(getRequestedTenantId(new Headers({ 'x-tenant-id': value }))).toBe('!invalid-tenant-hint!'));
  it.each(['tugpt_tenant_id=%ZZ', 'tugpt_tenant_id=', 'tugpt_tenant_id=a; tugpt_tenant_id=b'])('fails closed for malformed/ambiguous cookies %s', cookie => expect(getRequestedTenantId(new Headers({ cookie }))).toBe('!invalid-tenant-hint!'));
});
