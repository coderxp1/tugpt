/**
 * PATCH  /api/v1/organizations/current/members/:userId — { "role": "manager" } change a member's role.
 * DELETE /api/v1/organizations/current/members/:userId — remove a member, or leave when :userId is you.
 *
 * Both call `public.manage_organization_member` (20261121700001), which owns
 * every rule: owner/admin only, admins only below admin and never above their
 * own rank (P3S07), owners guarded by the last-owner trigger (P3S05),
 * cross-tenant ids answered as not found (P3S01/P3S06). Every change is
 * audited (`membership.set_role` / `membership.remove` / `membership.leave`).
 */
import { defaultLogger } from '@tugpt/observability';
import { isSameOriginMutation, isUuid, readJsonRecord } from '@/lib/http/mutations';
import {
  dashboardContext, errorResponse, isResponse, privateJson, requestIdOf, rpcErrorResponse, type Rpc,
} from '@/lib/dashboard-api/http';
import { isOrganizationRole } from '@/lib/dashboard-api/permissions';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ userId: string }> };
type Result = { organization_id: string; user_id: string; action: string; previous_role: string | null; role: string | null; changed: boolean };

function body(r: Result) {
  return { userId: r.user_id, action: r.action, previousRole: r.previous_role, role: r.role, changed: r.changed };
}

export async function PATCH(request: Request, { params }: Params) {
  if (!isSameOriginMutation(request)) return errorResponse(403, 'FORBIDDEN', 'Same-origin JSON request required');
  const requestId = requestIdOf(request);
  try {
    const { userId } = await params;
    if (!isUuid(userId)) return errorResponse(404, 'MEMBER_NOT_FOUND', 'Member not found');
    const ctx = await dashboardContext(request);
    if (isResponse(ctx)) return ctx;

    let input: { role?: unknown };
    try {
      input = await readJsonRecord(request, ['role']);
    } catch {
      return errorResponse(400, 'INVALID_BODY', 'Invalid JSON request body');
    }
    if (!isOrganizationRole(input.role)) return errorResponse(400, 'INVALID_BODY', 'role must be a known organization role');

    const { data, error } = await (ctx.supabase as unknown as Rpc).rpc('manage_organization_member', {
      p_organization_id: ctx.tenant.organizationId, p_user_id: userId, p_action: 'set_role', p_role: input.role,
    });
    if (error) {
      defaultLogger.warn('Member role RPC failed', {
        requestId, organizationId: ctx.tenant.organizationId, sqlstateCode: (error as { code?: string }).code,
      });
      return rpcErrorResponse(error);
    }
    const r = data as Result;
    defaultLogger.info('Member role changed', { requestId, organizationId: ctx.tenant.organizationId, role: r.role, changed: r.changed });
    return privateJson({ member: body(r) });
  } catch (err) {
    defaultLogger.error('Member role change failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}

export async function DELETE(request: Request, { params }: Params) {
  if (!isSameOriginMutation(request)) return errorResponse(403, 'FORBIDDEN', 'Same-origin JSON request required');
  const requestId = requestIdOf(request);
  try {
    const { userId } = await params;
    if (!isUuid(userId)) return errorResponse(404, 'MEMBER_NOT_FOUND', 'Member not found');
    const ctx = await dashboardContext(request);
    if (isResponse(ctx)) return ctx;

    const { data, error } = await (ctx.supabase as unknown as Rpc).rpc('manage_organization_member', {
      p_organization_id: ctx.tenant.organizationId, p_user_id: userId, p_action: 'remove', p_role: null,
    });
    if (error) {
      defaultLogger.warn('Member removal RPC failed', {
        requestId, organizationId: ctx.tenant.organizationId, sqlstateCode: (error as { code?: string }).code,
      });
      return rpcErrorResponse(error);
    }
    const r = data as Result;
    const left = userId === ctx.user.id;
    defaultLogger.info(left ? 'Member left organization' : 'Member removed', { requestId, organizationId: ctx.tenant.organizationId });
    // The RPC reports p_action ('remove'); the audit trail records self-removal
    // as membership.leave, and the API contract reports the same.
    const response = privateJson({ member: { ...body(r), action: left ? 'leave' : 'remove' }, left });
    // Leaving the active organization: drop the stale selection so the next
    // request falls back to another membership instead of answering 403.
    if (left) response.cookies.set('tugpt_tenant_id', '', { httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 0 });
    return response;
  } catch (err) {
    defaultLogger.error('Member removal failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}
