import { describe, expect, it } from 'vitest';
import { assignableRoles, canLeave, canManageMember, isOrganizationRole, organizationPermissions } from './permissions';

describe('dashboard permission hints mirror 20261121700001', () => {
  it('owners manage anyone but themselves', () => {
    for (const t of ['owner', 'admin', 'manager', 'agent', 'viewer'] as const) expect(canManageMember('owner', t, false)).toBe(true);
    expect(canManageMember('owner', 'owner', true)).toBe(false);
  });
  it('admins manage only members strictly below admin', () => {
    expect(canManageMember('admin', 'owner', false)).toBe(false);
    expect(canManageMember('admin', 'admin', false)).toBe(false);
    expect(canManageMember('admin', 'manager', false)).toBe(true);
    expect(canManageMember('admin', 'viewer', false)).toBe(true);
  });
  it('managers, agents and viewers manage nobody', () => {
    for (const a of ['manager', 'agent', 'viewer'] as const) expect(canManageMember(a, 'viewer', false)).toBe(false);
  });
  it('assignable roles never exceed the actor rank', () => {
    expect(assignableRoles('owner')).toContain('owner');
    expect(assignableRoles('admin')).toEqual(['admin', 'manager', 'agent', 'viewer']);
    expect(assignableRoles('manager')).toEqual([]);
  });
  it('the last owner cannot leave; anyone else can', () => {
    expect(canLeave('owner', 1)).toBe(false);
    expect(canLeave('owner', 2)).toBe(true);
    expect(canLeave('viewer', 1)).toBe(true);
  });
  it('only owner/admin edit settings and invite; only owners transfer; managers read audit', () => {
    expect(organizationPermissions('admin')).toMatchObject({ editSettings: true, invite: true, transferOwnership: false, viewAuditLog: true });
    expect(organizationPermissions('manager')).toMatchObject({ editSettings: false, invite: false, manageMembers: false, viewAuditLog: true });
    expect(organizationPermissions('viewer')).toMatchObject({ editSettings: false, invite: false, viewAuditLog: false });
    expect(organizationPermissions('owner').transferOwnership).toBe(true);
  });
  it('recognizes only real roles', () => {
    expect(isOrganizationRole('admin')).toBe(true);
    expect(isOrganizationRole('superadmin')).toBe(false);
    expect(isOrganizationRole(undefined)).toBe(false);
  });
});
