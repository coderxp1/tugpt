import { getRequestedTenantId } from '@/lib/tenant/request';
/**
 * GET /api/v1/conversations
 *
 * The unified inbox: an organization's conversations, most recently active
 * first, filterable by status, paged by keyset cursor. The Sep 25 milestone.
 *
 * WHY IT IS BEHIND THE SAME FEATURE GATE AS THE DRAFT ROUTES
 *
 * `ai_draft_generation` gates every reviewer-facing route in this API, and this
 * is one — the inbox exists to route a reviewer to a draft. Gating it on
 * something else, or on nothing, would produce a working inbox in an
 * organization where every row it links to answers 503, which is a worse
 * experience than an honest "not available yet" and a second thing to reason
 * about when the flag is finally turned on for a pilot organization.
 *
 * WHAT IT DOES NOT RETURN
 *
 * No message previews, no raw `contact_phone`, no `whatsapp_connection_id`.
 * See `lib/conversations/types.ts` — a preview on a list endpoint is the
 * largest single expansion of customer data this product could make, and the
 * screen does not need it to route anybody.
 */

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createFeatureServerClient } from '@/lib/supabase/server';
import { AuthService } from '@tugpt/auth';
import { checkDraftFeatureGate } from '@/lib/draft-api/feature-gate';
import {
  ConversationInboxService,
  DEFAULT_INBOX_LIMIT,
  decodeCursor,
} from '@/lib/conversations/service';
import {
  INBOX_ASSIGNMENTS,
  INBOX_FILTERS,
  type InboxAssignment,
  type InboxFilter,
} from '@/lib/conversations/types';
import type { ApiError } from '@/lib/draft-api/types';

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return privateJson(body, { status });
}

/**
 * `?limit=`, or the default.
 *
 * A malformed value falls back rather than 400ing, exactly as the thread route
 * does: the page size is a display preference, not part of what is being asked
 * for. The service clamps whatever number it is handed; this only has to avoid
 * handing it `NaN`.
 *
 * `?cursor=` is treated the opposite way, deliberately — see below.
 */
function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_INBOX_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_INBOX_LIMIT;
}

export async function GET(request: Request) {
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;
  const rawTenantId = getRequestedTenantId(request.headers);

  try {
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

    const params = new URL(request.url).searchParams;

    const statusParam = params.get('status') ?? 'all';
    if (!INBOX_FILTERS.includes(statusParam as InboxFilter)) {
      return errorResponse(400, 'INVALID_QUERY', 'Invalid status filter');
    }

    // A bad cursor is a 400, while a bad `limit` above is not, and the
    // difference is not an inconsistency. A limit is how the answer is
    // presented; a cursor is part of the question — it says *which*
    // conversations are being asked for. Silently ignoring it would answer a
    // different question than the one asked and return page one, which a Next
    // button turns into an infinite loop through the same rows.
    const assignmentParam = params.get('assignment') ?? 'all';
    if (!INBOX_ASSIGNMENTS.includes(assignmentParam as InboxAssignment)) {
      return errorResponse(400, 'INVALID_QUERY', 'Invalid assignment filter');
    }

    const rawCursor = params.get('cursor');
    const cursor = decodeCursor(rawCursor);
    if (rawCursor !== null && cursor === null) {
      return errorResponse(400, 'INVALID_QUERY', 'Invalid pagination cursor');
    }

    const inbox = new ConversationInboxService(supabase);
    const page = await inbox.listConversations(activeTenant.organizationId, {
      status: statusParam as InboxFilter,
      assignment: assignmentParam as InboxAssignment,
      // From the session, never from the query string. A caller that could name
      // the reviewer could read a colleague's queue by asking for it.
      viewerId: user.id,
      limit: parseLimit(params.get('limit')),
      cursor,
    });

    // Counts and flags only. No contact values, no conversation ids, no
    // message text — this endpoint sits on top of the whole customer list.
    defaultLogger.info('Conversation inbox listed', {
      requestId,
      organizationId: activeTenant.organizationId,
      statusFilter: statusParam,
      assignmentFilter: assignmentParam,
      count: page.conversations.length,
      hasMore: page.next_cursor !== null,
      paged: cursor !== null,
    });

    return privateJson(page);
  } catch (err) {
    defaultLogger.error('Conversation inbox failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}

/** Personalized/error responses must never enter a shared response cache. */
function privateJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'private, no-store');
  return NextResponse.json(body, { ...init, headers });
}
