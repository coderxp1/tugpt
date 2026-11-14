import { isSameOriginMutation, readJsonRecord } from '@/lib/http/mutations';
import { getRequestedTenantId } from '@/lib/tenant/request';
/**
 * POST /api/v1/invitations/:invitationId/revoke
 *
 * Withdraw a pending invitation. This is the only way to kill a token that is
 * already in someone's inbox, which makes it the counterpart to the "returned
 * once, never recoverable" rule on creation: the answer to a leaked or
 * mis-sent invitation is to revoke and reissue, so revoke has to work and has
 * to be reachable.
 *
 * The RPC answers P3D01 — not found — both for an invitation in another
 * organization and for one that does not exist. This route passes that through
 * unchanged rather than upgrading it to 403, because the whole point of the
 * single answer is that invitation ids cannot be probed across tenants.
 */

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { AuthService } from '@tugpt/auth';
import { mapDraftRpcError } from '@/lib/draft-api/error-mapper';
import type { ApiError } from '@/lib/draft-api/types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return privateJson(body, { status });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ invitationId: string }> }
) {
  if (!isSameOriginMutation(request)) return errorResponse(403, 'FORBIDDEN', 'Same-origin JSON request required');
  try { await readJsonRecord(request, []); } catch { return errorResponse(400, 'INVALID_BODY', 'An empty JSON object is required'); }
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;
  const rawTenantId = getRequestedTenantId(request.headers);

  try {
    const { invitationId } = await params;
    if (!UUID_REGEX.test(invitationId)) {
      return errorResponse(400, 'INVALID_UUID', 'Invalid invitation ID format');
    }

    const supabase = await createAuthenticatedServerClient();
    const authService = new AuthService(supabase);
    const user = await authService.getCurrentUser();
    if (!user) return errorResponse(401, 'UNAUTHENTICATED', 'Authentication required');

    const activeTenant = await authService.resolveTenantContext(user.id, rawTenantId);
    if (!activeTenant) return errorResponse(403, 'FORBIDDEN', 'No active organization found');

    const { data, error: rpcError } = await (
      supabase as unknown as {
        rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
      }
    ).rpc('revoke_invitation', { p_invitation_id: invitationId });

    if (rpcError) {
      const mapped = mapDraftRpcError(rpcError as { code?: string });
      defaultLogger.warn('Invitation revoke RPC failed', {
        requestId,
        organizationId: activeTenant.organizationId,
        sqlstateCode: (rpcError as { code?: string }).code,
        httpStatus: mapped.status,
      });
      return errorResponse(mapped.status, mapped.code, mapped.message);
    }

    defaultLogger.info('Invitation revoked', {
      requestId,
      organizationId: activeTenant.organizationId,
      invitationId,
    });

    return privateJson({ invitation: data });
  } catch (err) {
    defaultLogger.error('Invitation revoke failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}

/** Personalized/error responses must never enter a shared response cache. */
function privateJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'private, no-store');
  return NextResponse.json(body, { ...init, headers });
}
