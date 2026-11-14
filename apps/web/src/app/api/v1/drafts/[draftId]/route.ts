import { getRequestedTenantId } from '@/lib/tenant/request';
// Stage 5A: GET /api/v1/drafts/:draftId — Single draft detail with source message and conversation context
// Amendment 2: Filters by resolved active tenant's organization_id.
// Amendment 6: Minimizes customer data returned (no provider_message_id, no operational IDs).

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createFeatureServerClient } from '@/lib/supabase/server';
import { AuthService } from '@tugpt/auth';
import { DraftApiService } from '@/lib/draft-api/service';
import { checkDraftFeatureGate } from '@/lib/draft-api/feature-gate';
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

    // Amendment 4: Validate UUID
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

    // Feature gate check
    const featureClient = await createFeatureServerClient(activeTenant.organizationId);
    const gate = await checkDraftFeatureGate(featureClient, activeTenant.organizationId);
    if (!gate.allowed) {
      return errorResponse(gate.statusCode, 'FEATURE_UNAVAILABLE', gate.message);
    }

    // Amendment 2: Filter by active tenant's organization_id
    const draftService = new DraftApiService(supabase);
    const draft = await draftService.getDraftDetail(activeTenant.organizationId, draftId);

    if (!draft) {
      return errorResponse(404, 'DRAFT_NOT_FOUND', 'Draft not found');
    }

    defaultLogger.info('Draft detail retrieved', { requestId, outcome: 'success' });

    return privateJson({ draft });
  } catch {
    defaultLogger.error('Draft detail failed', undefined, { requestId, failureKind: 'unexpected', httpStatus: 500 });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}
/** Personalized/error responses must never enter a shared response cache. */
function privateJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'private, no-store');
  return NextResponse.json(body, { ...init, headers });
}
