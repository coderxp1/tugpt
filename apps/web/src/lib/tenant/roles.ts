/**
 * Owners and admins of the active organization may approve customer MCP calls in chat.
 * This is a UI hint only: the approval routes and the database check the role again.
 * A request that selected an organization the person does not belong to never counts.
 */
export interface RoleSource {
  readonly requestedTenantRejected?: boolean;
  readonly tenant?: { readonly role?: string | null } | null;
}

export function canApproveMcpCalls(session: RoleSource | null | undefined): boolean {
  if (!session || session.requestedTenantRejected) return false;
  const role = session.tenant?.role;
  return role === 'owner' || role === 'admin';
}

/** Owners and admins manage the organization's knowledge (UI hint; RLS enforces it on write). */
export function canManageKnowledge(session: RoleSource | null | undefined): boolean {
  return canApproveMcpCalls(session);
}
