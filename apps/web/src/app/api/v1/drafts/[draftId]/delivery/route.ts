// GET /api/v1/drafts/:draftId/delivery — the outbound delivery state
// for one draft, for the review UI.
//
// Read path: session → tenant → feature gate → draft visible under
// the active org (session client, RLS) → the delivery row via the
// service-role RPC get_outbound_delivery_for_draft (migration
// 20261022000003), which derives the organization from the draft
// itself. A draft from another organization fails the visibility
// check and gets the same 404 as a missing draft — delivery state
// is never leaked across tenants.
//
// A draft with no delivery returns 200 { delivery: null }: pending
// and rejected drafts legitimately have none, and an approved draft
// approved before the delivery workflow existed has none either.
// The UI shows a delivery badge only when a delivery exists.

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@tugpt/database';
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
  return NextResponse.json(body, { status });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ draftId: string }> }
) {
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;
  const rawTenantId = request.headers.get('x-tenant-id');

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

    const adminClient = createAdminSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    const gate = await checkDraftFeatureGate(adminClient, activeTenant.organizationId);
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error: rpcError } = await (adminClient as any).rpc(
      'get_outbound_delivery_for_draft',
      { p_draft_id: draftId }
    );

    if (rpcError) {
      defaultLogger.warn('Delivery read RPC failed', {
        requestId,
        draftId,
        organizationId: activeTenant.organizationId,
        sqlstateCode: rpcError.code,
      });
      return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
    }

    const rows = (data ?? []) as DeliveryRow[];
    const delivery = rows.length > 0 ? toDeliveryView(rows[0]) : null;

    return NextResponse.json({ delivery });
  } catch (err) {
    defaultLogger.error('Delivery read failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}
