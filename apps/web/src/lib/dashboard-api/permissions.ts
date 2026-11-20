/**
 * Dashboard permission hints for team and organization management.
 *
 * THESE ARE HINTS, NOT AUTHORIZATION. The database decides every one of these
 * questions inside `public.manage_organization_member`,
 * `public.update_organization_settings` and
 * `public.transfer_organization_ownership` (migration 20261121700001). This
 * module mirrors those rules so the Dashboard can hide a button the database
 * would refuse anyway; if the two ever disagree, the database wins and the
 * screen shows the mapped error. Keep this file in step with that migration.
 */

export const ORGANIZATION_ROLES = ['owner', 'admin', 'manager', 'agent', 'viewer'] as const;
export type OrganizationRoleName = (typeof ORGANIZATION_ROLES)[number];

const RANK: Record<OrganizationRoleName, number> = { owner: 50, admin: 40, manager: 30, agent: 20, viewer: 10 };

export function isOrganizationRole(value: unknown): value is OrganizationRoleName {
  return typeof value === 'string' && (ORGANIZATION_ROLES as readonly string[]).includes(value);
}

function rank(role: OrganizationRoleName): number {
  return RANK[role];
}

/** Roles this actor may assign to someone else (owner: any; admin: up to admin). */
export function assignableRoles(actor: OrganizationRoleName): OrganizationRoleName[] {
  if (actor === 'owner') return [...ORGANIZATION_ROLES];
  if (actor === 'admin') return ORGANIZATION_ROLES.filter((r) => r !== 'owner');
  return [];
}

/**
 * Whether the actor may change the target's role or remove them.
 * Owners manage anyone; admins manage only members strictly below admin.
 * Leaving (removing yourself) is separate: see `canLeave`.
 */
export function canManageMember(
  actor: OrganizationRoleName,
  target: OrganizationRoleName,
  isSelf: boolean
): boolean {
  if (isSelf) return false;
  if (actor === 'owner') return true;
  if (actor === 'admin') return rank(target) < rank('admin');
  return false;
}

/**
 * Any member may leave. The database still refuses the last owner (P3S05),
 * which needs the owner count, so this takes it.
 */
export function canLeave(actor: OrganizationRoleName, ownerCount: number): boolean {
  return actor !== 'owner' || ownerCount > 1;
}

export interface OrganizationPermissions {
  readonly editSettings: boolean;
  readonly manageMembers: boolean;
  readonly invite: boolean;
  readonly transferOwnership: boolean;
  readonly viewAuditLog: boolean;
  readonly assignableRoles: OrganizationRoleName[];
}

export function organizationPermissions(actor: OrganizationRoleName): OrganizationPermissions {
  const isOwnerOrAdmin = actor === 'owner' || actor === 'admin';
  return {
    editSettings: isOwnerOrAdmin,
    manageMembers: isOwnerOrAdmin,
    // private.create_invitation (20260902000001): owner/admin only (P3D02),
    // at or below their own rank (P3D08).
    invite: isOwnerOrAdmin,
    transferOwnership: actor === 'owner',
    // audit_logs SELECT policy: owner/admin/manager.
    viewAuditLog: isOwnerOrAdmin || actor === 'manager',
    assignableRoles: assignableRoles(actor),
  };
}
