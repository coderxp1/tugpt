/**
 * POST /api/v1/organizations/current/transfer-ownership — { "userId": "<uuid>" }
 *
 * `public.transfer_organization_ownership` (20261102000001): only an owner;
 * the new owner must be another existing member (P3S03). The caller becomes
 * admin. Audited as `organization.transfer_ownership`.
 */
import { defaultLogger } from '@tugpt/observability';
import { isSameOriginMutation, isUuid, readJsonRecord } from '@/lib/http/mutations';
import {
  dashboardContext, errorResponse, isResponse, privateJson, requestIdOf, rpcErrorResponse, type Rpc,
} from '@/lib/dashboard-api/http';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return errorResponse(403, 'FORBIDDEN', 'Same-origin JSON request required');
  const requestId = requestIdOf(request);
  try {
    const ctx = await dashboardContext(request);
    if (isResponse(ctx)) return ctx;

    let body: { userId?: unknown };
    try {
      body = await readJsonRecord(request, ['userId']);
    } catch {
      return errorResponse(400, 'INVALID_BODY', 'Invalid JSON request body');
    }
    if (!isUuid(body.userId)) return errorResponse(400, 'INVALID_BODY', 'userId must be a member id');

    const { data, error } = await (ctx.supabase as unknown as Rpc).rpc('transfer_organization_ownership', {
      p_organization_id: ctx.tenant.organizationId,
      p_new_owner_id: body.userId,
    });
    if (error) {
      defaultLogger.warn('Ownership transfer RPC failed', {
        requestId, organizationId: ctx.tenant.organizationId, sqlstateCode: (error as { code?: string }).code,
      });
      return rpcErrorResponse(error);
    }
    defaultLogger.info('Ownership transferred', { requestId, organizationId: ctx.tenant.organizationId });
    const r = data as { organization_id: string; owner_id: string };
    return privateJson({ organizationId: r.organization_id, ownerId: r.owner_id, yourRole: 'admin' });
  } catch (err) {
    defaultLogger.error('Ownership transfer failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}
