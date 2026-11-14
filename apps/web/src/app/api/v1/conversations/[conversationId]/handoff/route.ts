import { isSameOriginMutation, readJsonRecord } from '@/lib/http/mutations';
import { getRequestedTenantId } from '@/lib/tenant/request';
/**
 * POST /api/v1/conversations/:conversationId/handoff
 *
 * Turn AI drafting off for one conversation, or back on. The Sep 25 milestone.
 *
 * THIS IS A KILL SWITCH, NOT A LABEL
 *
 * `process_inbound_message` enqueues a draft-generation job only for
 * conversations whose status is `open` (migration 20260805000017). Setting
 * `needs_human` therefore stops the AI drafting replies for that customer, and
 * setting it back to `open` starts it again. Until this route existed, nothing
 * in the product had ever written `needs_human` — it was a declared state with
 * no producer.
 *
 * That is why the state change is recorded in `conversation_events` with its
 * actor, and why the route logs the direction: "who turned the AI off for this
 * customer, and who turned it back on" has to be answerable, and a status
 * column only ever answers "what is it now".
 *
 * `expectedStatus` is required for the same reason `expectedAssignee` is on the
 * assign route — two reviewers acting on the same stale screen should not both
 * silently win.
 */

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createFeatureServerClient } from '@/lib/supabase/server';
import { AuthService } from '@tugpt/auth';
import { checkDraftFeatureGate } from '@/lib/draft-api/feature-gate';
import { mapDraftRpcError } from '@/lib/draft-api/error-mapper';
import type { ApiError } from '@/lib/draft-api/types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The statuses a caller may claim to have seen.
 *
 * `closed` is accepted as an *expectation* and refused by the RPC as a
 * *transition* (P3C05). Rejecting it here instead would turn a deliberate
 * product rule into a validation message, and put the rule in two places.
 */
const CONVERSATION_STATUSES = ['open', 'needs_human', 'closed'] as const;

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return privateJson(body, { status });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  if (!isSameOriginMutation(request)) return errorResponse(403, 'FORBIDDEN', 'Same-origin JSON request required');
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;
  const rawTenantId = getRequestedTenantId(request.headers);

  try {
    const { conversationId } = await params;

    if (!UUID_REGEX.test(conversationId)) {
      return errorResponse(400, 'INVALID_UUID', 'Invalid conversation ID format');
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

    let body: { needsHuman?: unknown; expectedStatus?: unknown };
    try {
      body = await readJsonRecord(request, ["needsHuman", "expectedStatus"]);
    } catch {
      return errorResponse(400, 'INVALID_BODY', 'Invalid JSON request body');
    }

    // Strictly boolean. Accepting truthiness here would let `"false"` — which
    // is what a form field sends — turn the AI *off* while the caller believed
    // it was turning it on.
    if (typeof body.needsHuman !== 'boolean') {
      return errorResponse(400, 'INVALID_BODY', 'needsHuman must be a boolean');
    }

    if (
      typeof body.expectedStatus !== 'string' ||
      !CONVERSATION_STATUSES.includes(body.expectedStatus as (typeof CONVERSATION_STATUSES)[number])
    ) {
      return errorResponse(400, 'INVALID_BODY', 'expectedStatus must be a known conversation status');
    }

    const { data, error: rpcError } = await (
      supabase as unknown as {
        rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
      }
    ).rpc('set_conversation_handoff', {
      p_conversation_id: conversationId,
      p_needs_human: body.needsHuman,
      p_expected_status: body.expectedStatus,
    });

    if (rpcError) {
      const mapped = mapDraftRpcError(rpcError as { code?: string });
      defaultLogger.warn('Conversation handoff RPC failed', {
        requestId,
        organizationId: activeTenant.organizationId,
        sqlstateCode: (rpcError as { code?: string }).code,
        httpStatus: mapped.status,
      });
      return errorResponse(mapped.status, mapped.code, mapped.message);
    }

    // Logged at info with the direction, because this is the record of AI
    // generation being switched off or on for a customer. No contact, no text.
    defaultLogger.info('Conversation handoff changed', {
      requestId,
      organizationId: activeTenant.organizationId,
      aiDraftingEnabled: !body.needsHuman,
    });

    return privateJson({ conversation: data });
  } catch (err) {
    defaultLogger.error('Conversation handoff failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}

/** Personalized/error responses must never enter a shared response cache. */
function privateJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'private, no-store');
  return NextResponse.json(body, { ...init, headers });
}
