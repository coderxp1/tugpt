import { isSameOriginMutation, readJsonRecord } from '@/lib/http/mutations';
import { getRequestedTenantId } from '@/lib/tenant/request';
/**
 * POST /api/v1/invitations — invite someone into an organization.
 * GET  /api/v1/invitations — list this organization's invitations.
 *
 * THE TOKEN IS RETURNED ONCE AND IS NOT STORED
 *
 * `create_invitation` generates the token, stores only its SHA-256, and hands
 * the plaintext back in the RPC result. This route is the only place it will
 * ever exist outside the invitee's inbox. It is put in the response body and
 * deliberately kept out of the logs — the log line below records that an
 * invitation was created and at what role, and nothing that could be used to
 * accept it.
 *
 * If the caller loses it, the invitation is revoked and reissued. There is no
 * recovery path and there should not be one: a token you can look up again is
 * a token an operator can look up too.
 *
 * WHAT THIS ROUTE DOES NOT DECIDE
 *
 * Not whether the caller may invite, not whether the role is permitted, not
 * whether the address is already a member. All of that is in the RPC, which
 * derives the organization from a locked row and checks membership and rank
 * against it. A second copy here would be a second thing to get wrong, and the
 * two would drift.
 */

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { AuthService } from '@tugpt/auth';
import { mapDraftRpcError } from '@/lib/draft-api/error-mapper';
import type { ApiError } from '@/lib/draft-api/types';

/**
 * The roles an invitation may name.
 *
 * `owner` is present because an owner inviting a co-owner is legitimate; the
 * RPC refuses it for anyone below owner (P3D08). Rejecting it here instead
 * would put half of one rule in two places.
 */
const INVITABLE_ROLES = ['owner', 'admin', 'manager', 'agent', 'viewer'] as const;

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return privateJson(body, { status });
}

type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> };

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return errorResponse(403, 'FORBIDDEN', 'Same-origin JSON request required');
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;
  const rawTenantId = getRequestedTenantId(request.headers);

  try {
    const supabase = await createAuthenticatedServerClient();
    const authService = new AuthService(supabase);
    const user = await authService.getCurrentUser();
    if (!user) return errorResponse(401, 'UNAUTHENTICATED', 'Authentication required');

    const activeTenant = await authService.resolveTenantContext(user.id, rawTenantId);
    if (!activeTenant) return errorResponse(403, 'FORBIDDEN', 'No active organization found');

    let body: { email?: unknown; role?: unknown };
    try {
      body = await readJsonRecord(request, ["email", "role"]);
    } catch {
      return errorResponse(400, 'INVALID_BODY', 'Invalid JSON request body');
    }

    if (typeof body.email !== 'string' || body.email.trim() === '' || body.email.length > 320) {
      return errorResponse(400, 'INVALID_BODY', 'email is required');
    }
    if (typeof body.role !== 'string' || !INVITABLE_ROLES.includes(body.role as (typeof INVITABLE_ROLES)[number])) {
      return errorResponse(400, 'INVALID_BODY', 'role must be a known organization role');
    }

    const { data, error: rpcError } = await (supabase as unknown as Rpc).rpc('create_invitation', {
      p_organization_id: activeTenant.organizationId,
      p_email: body.email,
      p_role: body.role,
    });

    if (rpcError) {
      const mapped = mapDraftRpcError(rpcError as { code?: string });
      defaultLogger.warn('Invitation create RPC failed', {
        requestId,
        organizationId: activeTenant.organizationId,
        sqlstateCode: (rpcError as { code?: string }).code,
        httpStatus: mapped.status,
      });
      return errorResponse(mapped.status, mapped.code, mapped.message);
    }

    const result = data as { invitation_id: string; token: string; email: string; role: string; expires_at: string };

    // Role and id, never the token and never the address. An invitee's email
    // is a person's contact detail; the log does not need it to be useful.
    defaultLogger.info('Invitation created', {
      requestId,
      organizationId: activeTenant.organizationId,
      invitationId: result.invitation_id,
      role: result.role,
    });

    return privateJson({ invitation: result }, { status: 201 });
  } catch (err) {
    defaultLogger.error('Invitation create failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}

export async function GET(request: Request) {
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;
  const rawTenantId = getRequestedTenantId(request.headers);

  try {
    const supabase = await createAuthenticatedServerClient();
    const authService = new AuthService(supabase);
    const user = await authService.getCurrentUser();
    if (!user) return errorResponse(401, 'UNAUTHENTICATED', 'Authentication required');

    const activeTenant = await authService.resolveTenantContext(user.id, rawTenantId);
    if (!activeTenant) return errorResponse(403, 'FORBIDDEN', 'No active organization found');

    // `token_hash` is not selected. It is not usable as a credential, but it
    // is the one column whose value would let an operator with log or response
    // access confirm a guessed token offline, and no screen needs it.
    const { data, error } = await supabase
      .from('organization_invitations')
      .select('id, email, role, status, expires_at, created_at')
      .eq('organization_id', activeTenant.organizationId)
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      defaultLogger.warn('Invitation list failed', { requestId, organizationId: activeTenant.organizationId });
      return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
    }

    return privateJson({ invitations: data ?? [] });
  } catch (err) {
    defaultLogger.error('Invitation list failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}

/** Personalized/error responses must never enter a shared response cache. */
function privateJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'private, no-store');
  return NextResponse.json(body, { ...init, headers });
}
