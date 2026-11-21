/**
 * GET /api/v1/organizations/current/members — members of the active organization with per-row
 * permission hints for the caller.
 *
 * Read through the caller's RLS-bound client: the member-list policy and the
 * co-member profile policy decide what is visible. Hints mirror the RPC rules
 * (lib/dashboard-api/permissions.ts); the RPC remains the authority.
 */
import { defaultLogger } from '@tugpt/observability';
import { dashboardContext, errorResponse, isResponse, privateJson, requestIdOf } from '@/lib/dashboard-api/http';
import { canLeave, canManageMember, isOrganizationRole, organizationPermissions } from '@/lib/dashboard-api/permissions';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const requestId = requestIdOf(request);
  try {
    const ctx = await dashboardContext(request);
    if (isResponse(ctx)) return ctx;
    const orgId = ctx.tenant.organizationId;

    const { data: rows, error } = await ctx.supabase
      .from('organization_members')
      .select('user_id, role, created_at')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: true })
      .limit(1000);
    if (error || !rows) {
      defaultLogger.warn('Member list failed', { requestId, organizationId: orgId });
      return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
    }
    const members = rows as { user_id: string; role: string; created_at: string }[];

    const people = new Map<string, { full_name: string | null; email: string | null; avatar_url: string | null }>();
    if (members.length) {
      const { data: profiles, error: profileError } = await ctx.supabase
        .from('profiles')
        .select('id, full_name, email, avatar_url')
        .in('id', members.map((m) => m.user_id));
      if (profileError) {
        defaultLogger.warn('Member profile read failed', { requestId, organizationId: orgId });
        return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
      }
      for (const p of (profiles ?? []) as { id: string; full_name: string | null; email: string | null; avatar_url: string | null }[]) {
        people.set(p.id, p);
      }
    }

    const actor = ctx.tenant.role;
    const ownerCount = members.filter((m) => m.role === 'owner').length;
    return privateJson({
      members: members.map((m) => {
        const isSelf = m.user_id === ctx.user.id;
        const role = isOrganizationRole(m.role) ? m.role : 'viewer';
        const p = people.get(m.user_id);
        return {
          userId: m.user_id,
          name: p?.full_name ?? null,
          email: p?.email ?? null,
          avatarUrl: p?.avatar_url ?? null,
          role: m.role,
          joinedAt: m.created_at,
          isSelf,
          canChangeRole: canManageMember(actor, role, isSelf),
          canRemove: isSelf ? canLeave(actor, ownerCount) : canManageMember(actor, role, isSelf),
        };
      }),
      ownerCount,
      permissions: organizationPermissions(actor),
    });
  } catch (err) {
    defaultLogger.error('Member list failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}
