import { getRequestedTenantId } from '@/lib/tenant/request';
/**
 * GET /api/v1/drafts/:draftId/thread
 *
 * The conversation a draft belongs to, so a reviewer can read the customer's
 * history beside the reply they are about to approve. The Sep 18 milestone.
 *
 * WHY IT IS A DRAFT ROUTE
 *
 * Authorization, tenant resolution and the feature gate are identical to every
 * other route in this directory, and they are identical because they are the
 * same three calls in the same order. A `/conversations/:id/messages` route
 * would need its own copy of all three and would be the second place to get
 * them wrong. See `DraftApiService.getConversationThread` for why the Sep 25
 * inbox does not make this the wrong shape.
 *
 * WHAT IT DELIBERATELY DOES NOT RETURN
 *
 * No `provider_message_id`, no `webhook_event_id`, no raw `contact_phone` —
 * Amendment 6. This is the request in the product that returns the most
 * customer text by far, so it is the one where "only what the screen renders"
 * has to be enforced rather than intended. `thread-route.test.ts` checks the
 * serialised body rather than the code.
 */

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createFeatureServerClient } from '@/lib/supabase/server';
import { AuthService } from '@tugpt/auth';
import { DraftApiService, DEFAULT_THREAD_LIMIT } from '@/lib/draft-api/service';
import { checkDraftFeatureGate } from '@/lib/draft-api/feature-gate';
import type { ApiError } from '@/lib/draft-api/types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return privateJson(body, { status });
}

/**
 * `?limit=`, or the default.
 *
 * A malformed value falls back rather than 400ing: the limit is a display
 * preference, not part of what is being asked for, and refusing to show a
 * reviewer their conversation because a query string was mistyped is the wrong
 * trade. The service clamps the number it is given — this only has to avoid
 * handing it `NaN`.
 */
function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_THREAD_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_THREAD_LIMIT;
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

    const limit = parseLimit(new URL(request.url).searchParams.get('limit'));

    const draftService = new DraftApiService(supabase);
    const thread = await draftService.getConversationThread(
      activeTenant.organizationId,
      draftId,
      limit
    );

    if (!thread) {
      return errorResponse(404, 'DRAFT_NOT_FOUND', 'Draft not found');
    }

    // Counts and flags only. No bodies, no contact, no message ids — this is
    // the one log line in the product that sits next to a pile of customer
    // text, and `docs/production_environment.md` is unambiguous about it.
    defaultLogger.info('Conversation thread retrieved', { requestId, outcome: 'success' });

    return privateJson({ thread });
  } catch {
    defaultLogger.error('Conversation thread failed', undefined, { requestId, failureKind: 'unexpected', httpStatus: 500 });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}

/** Personalized/error responses must never enter a shared response cache. */
function privateJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'private, no-store');
  return NextResponse.json(body, { ...init, headers });
}
