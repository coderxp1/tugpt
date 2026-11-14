import { isSameOriginMutation, readJsonRecord } from '@/lib/http/mutations';
import { getRequestedTenantId } from '@/lib/tenant/request';
/**
 * POST /api/v1/conversations/:conversationId/assign
 *
 * Claim a conversation, hand it to a colleague, or release it. The Sep 25
 * milestone, second part.
 *
 * WHY THE BODY CARRIES WHAT THE CALLER THINKS IS TRUE
 *
 * `expectedAssignee` is the assignee the browser was showing when the reviewer
 * clicked. The RPC refuses if the row says something else. Without it, two
 * reviewers looking at the same unclaimed conversation both succeed, one of
 * them silently loses it, and both go on to draft a reply to the same customer
 * — a double-work bug in a product whose whole value is a human reading each
 * reply.
 *
 * It is required rather than optional, and `null` means "I saw it unassigned"
 * rather than "I have no opinion". An optional field would make the safe
 * behaviour the one you have to remember.
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

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return privateJson(body, { status });
}

/** `null`, a UUID, or invalid. Anything else is not an assignee. */
function parseAssignee(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (typeof value === 'string' && UUID_REGEX.test(value)) return { ok: true, value };
  return { ok: false };
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

    let body: { assignee?: unknown; expectedAssignee?: unknown };
    try {
      body = await readJsonRecord(request, ["assignee", "expectedAssignee"]);
    } catch {
      return errorResponse(400, 'INVALID_BODY', 'Invalid JSON request body');
    }

    const assignee = parseAssignee(body.assignee);
    if (!assignee.ok) {
      return errorResponse(400, 'INVALID_BODY', 'assignee must be a UUID or null');
    }

    // Absent is not the same as null. `{}` would otherwise read as "I saw it
    // unassigned", which is the one value most likely to be wrong and the one
    // that silently wins a race.
    if (!('expectedAssignee' in body)) {
      return errorResponse(400, 'INVALID_BODY', 'expectedAssignee is required');
    }
    const expected = parseAssignee(body.expectedAssignee);
    if (!expected.ok) {
      return errorResponse(400, 'INVALID_BODY', 'expectedAssignee must be a UUID or null');
    }

    // The RPC derives the organization from the locked conversation row and
    // checks membership, role, and that the assignee belongs to the same
    // organization. None of that is re-implemented here, on purpose: a second
    // copy of an authorization rule is a second thing to get wrong.
    const { data, error: rpcError } = await (
      supabase as unknown as {
        rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
      }
    ).rpc('assign_conversation', {
      p_conversation_id: conversationId,
      p_assignee: assignee.value,
      p_expected_assignee: expected.value,
    });

    if (rpcError) {
      const mapped = mapDraftRpcError(rpcError as { code?: string });
      defaultLogger.warn('Conversation assign RPC failed', {
        requestId,
        organizationId: activeTenant.organizationId,
        sqlstateCode: (rpcError as { code?: string }).code,
        httpStatus: mapped.status,
      });
      return errorResponse(mapped.status, mapped.code, mapped.message);
    }

    // Ids and flags only — no contact, no message text. The RPC already returns
    // a narrow object for the same reason.
    defaultLogger.info('Conversation assignment changed', {
      requestId,
      organizationId: activeTenant.organizationId,
      released: assignee.value === null,
      selfAssigned: assignee.value === user.id,
    });

    return privateJson({ conversation: data });
  } catch (err) {
    defaultLogger.error('Conversation assign failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}

/** Personalized/error responses must never enter a shared response cache. */
function privateJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'private, no-store');
  return NextResponse.json(body, { ...init, headers });
}
