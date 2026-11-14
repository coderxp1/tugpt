import { getRequestedTenantId } from '@/lib/tenant/request';
// GET /api/v1/drafts/:draftId/delivery — the outbound delivery state
// for one draft, for the review UI.
//
// Read path: session -> tenant -> feature gate -> draft visibility (RLS)
// -> authenticated P2-DB-01 wrapper. The wrapper independently validates
// bridge/session/membership/feature and both draft and delivery tenants.
// Foreign and missing drafts retain the same 404 visibility contract.
//
// A draft with no delivery returns 200 { delivery: null }: pending
// and rejected drafts legitimately have none, and an approved draft
// approved before the delivery workflow existed has none either.
// The UI shows a delivery badge only when a delivery exists.

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createFeatureServerClient } from '@/lib/supabase/server';
import { AuthService } from '@tugpt/auth';
import { checkDraftFeatureGate } from '@/lib/draft-api/feature-gate';
import {
  toDeliveryView,
  type DeliveryRow,
} from '@/lib/draft-api/delivery-status';
import type { ApiError } from '@/lib/draft-api/types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return privateJson(body, { status });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ draftId: string }> }
) {
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

    const { data: draftRow, error: visibilityError } = await supabase
      .from('ai_drafts')
      .select('id')
      .eq('id', draftId)
      .eq('organization_id', activeTenant.organizationId)
      .single();

    if (visibilityError || !draftRow) {
      return errorResponse(404, 'DRAFT_NOT_FOUND', 'Draft not found');
    }

    const { data, error: rpcError } = await supabase.rpc(
      'sso_get_outbound_delivery_for_draft',
      { p_organization_id: activeTenant.organizationId, p_draft_id: draftId }
    );

    if (rpcError) {
      defaultLogger.warn('Delivery read RPC failed', {
        requestId, failureKind: 'rpc',
        httpStatus: 500,
      });
      return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
    }

    const rows = (data ?? []) as DeliveryRow[];
    const delivery = rows.length > 0 ? toDeliveryView(rows[0]) : null;

    return privateJson({ delivery });
  } catch {
    defaultLogger.error('Delivery read failed', undefined, { requestId, failureKind: 'unexpected', httpStatus: 500 });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}

/** Personalized/error responses must never enter a shared response cache. */
function privateJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'private, no-store');
  return NextResponse.json(body, { ...init, headers });
}
