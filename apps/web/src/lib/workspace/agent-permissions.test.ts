import { describe, expect, it } from 'vitest';
import type { OrganizationRole } from '@tugpt/database';
import { toAgent } from '@/lib/workspace-data/agents';
import { agentPermissions } from './agent-permissions';

// Exhaustive against the actual AuthService/database role type: a new role must
// receive an explicit expectation here, not inherit non-viewer write access.
const roles = {
  owner: { create: true, share: true },
  admin: { create: true, share: true },
  manager: { create: true, share: false },
  agent: { create: true, share: false },
  viewer: { create: false, share: false },
} satisfies Record<OrganizationRole, { create: boolean; share: boolean }>;
const cases = (Object.keys(roles) as OrganizationRole[]).flatMap((role) =>
  [true, false].flatMap((ownedByMe) => (['private', 'organization'] as const).map((visibility) => ({ role, ownedByMe, visibility }))));

describe('frontend permissions against backend agent serialization', () => {
  it.each(cases)('$role, owned=$ownedByMe, visibility=$visibility', ({ role, ownedByMe, visibility }) => {
    const resource = toAgent({
      id: 'a', owner_user_id: ownedByMe ? 'me' : 'other', name: 'Research',
      instructions: 'Private instructions', visibility, version: 1,
      created_at: '2026-01-01', updated_at: '2026-01-01',
    }, 'me', role, []);
    const expectedEdit = roles[role].create && ownedByMe && (visibility === 'private' || roles[role].share);
    const expectedDelete = roles[role].create && (ownedByMe || (visibility === 'organization' && roles[role].share));
    expect(resource.canEdit).toBe(expectedEdit);
    expect(resource.canDelete).toBe(expectedDelete);
    expect(agentPermissions(role, resource)).toEqual({ ...roles[role], edit: expectedEdit, delete: expectedDelete });
  });
  it.each(Object.keys(roles))('%s never infers resource grants from role alone', (role) => {
    expect(agentPermissions(role)).toEqual({ ...roles[role as OrganizationRole], edit: false, delete: false });
    expect(agentPermissions(role, { ownedByMe: true, canEdit: false, canDelete: false })).toEqual({ ...roles[role as OrganizationRole], edit: false, delete: false });
  });
});
