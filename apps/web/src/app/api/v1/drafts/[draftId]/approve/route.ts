import { isSameOriginMutation, readJsonRecord } from '@/lib/http/mutations';
import { getRequestedTenantId } from '@/lib/tenant/request';
// Stage 5A: POST /api/v1/drafts/:draftId/approve — Approve a draft
// Calls approve_and_enqueue_draft(draftId, expectedLockVersion) RPC via
// user-session client (migration 20261022000003): approval and outbound
// delivery enqueue commit or roll back together.
// Amendment 1: Approved/rejected are terminal. Edit on terminal → P3B04 from DB.
// Amendment 2: Confirms draft is visible under active org before calling RPC.
// Amendment 5: Exact SQLSTATE-to-HTTP mapping.

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createFeatureServerClient } from '@/lib/supabase/server';
import { AuthService } from '@tugpt/auth';
import { checkDraftFeatureGate } from '@/lib/draft-api/feature-gate';
import { mapDraftRpcError } from '@/lib/draft-api/error-mapper';
import type { ApiError } from '@/lib/draft-api/types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return privateJson(body, { status });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ draftId: string }> }
) {
  if (!isSameOriginMutation(request)) return errorResponse(403, 'FORBIDDEN', 'Same-origin JSON request required');
  // Diagnostic correlation is server-generated; never copy arbitrary header text.
  const requestId = `req-${Date.now()}`;
  const rawTenantId = getRequestedTenantId(request.headers);

  try {
    const { draftId } = await params;

    if (!UUID_REGEX.test(draftId)) {
      return errorResponse(400, 'INVALID_UUID', 'Invalid draft ID format');
    }

    const supabase = await createAuthenticatedServerClient();
    const authService = new AuthService(supabase);
    const user = await authService.getCurrentUser();

    if (!user) {
      return errorResponse(401, 'UNAUTHENTICATED', 'Authentication required');
    }

    const activeTenant = await authService.resolveTenantContext(user.id, rawTenantId);
    if (!activeTenant) {
      return errorResponse(403, 'FORBIDDEN', 'No active organization found');
    }

    const featureClient = await createFeatureServerClient(activeTenant.organizationId);
    const gate = await checkDraftFeatureGate(featureClient, activeTenant.organizationId);
    if (!gate.allowed) {
      return errorResponse(gate.statusCode, 'FEATURE_UNAVAILABLE', gate.message);
    }

    let body: { expectedLockVersion?: unknown };
    try {
      body = await readJsonRecord(request, ["expectedLockVersion"]);
    } catch {
      return errorResponse(400, 'INVALID_BODY', 'Invalid JSON request body');
    }

    if (typeof body.expectedLockVersion !== 'number' || !Number.isInteger(body.expectedLockVersion)) {
      return errorResponse(400, 'INVALID_BODY', 'expectedLockVersion must be an integer');
    }

    const { data: draftRow, error: visibilityError } = await supabase
      .from('ai_drafts')
      .select('id')
      .eq('id', draftId)
      .eq('organization_id', activeTenant.organizationId)
      .single();

    if (visibilityError || !draftRow) {
      return errorResponse(404, 'DRAFT_NOT_FOUND', 'Draft not found');
    }

    // Atomic approve + enqueue (migration 20261022000003): one RPC, one
    // transaction. If the delivery cannot be enqueued (inactive
    // connection, no content), the approval rolls back with it and the
    // mapped P3W error tells the reviewer why — a draft is never left
    // approved-but-silently-undeliverable, and a retry cannot create a
    // second delivery (the enqueue is idempotent per draft).
    const { data, error: rpcError } = // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).rpc('approve_and_enqueue_draft', {
      p_draft_id: draftId,
      p_expected_lock_version: body.expectedLockVersion,
    });

    if (rpcError) {
      const mapped = mapDraftRpcError(rpcError);
      defaultLogger.warn('Draft approve RPC failed', {
        requestId, failureKind: 'rpc',
        httpStatus: [400, 401, 403, 404, 409, 422, 500, 503].includes(mapped.status) ? mapped.status : 500,
      });
      return errorResponse(mapped.status, mapped.code, mapped.message);
    }

    defaultLogger.info('Draft approved and queued for delivery', { requestId, outcome: 'success' });

    const approvedRow = Array.isArray(data) ? data[0] : data;
    const delivery =
      approvedRow && typeof approvedRow === 'object' && 'delivery_id' in approvedRow
        ? {
            id: (approvedRow as { delivery_id: string }).delivery_id,
            status: (approvedRow as { delivery_status: string }).delivery_status,
          }
        : null;

    return privateJson({ draft: data, delivery });
  } catch {
    defaultLogger.error('Draft approve failed', undefined, { requestId, failureKind: 'unexpected', httpStatus: 500 });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}
/** Personalized/error responses must never enter a shared response cache. */
function privateJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'private, no-store');
  return NextResponse.json(body, { ...init, headers });
}
