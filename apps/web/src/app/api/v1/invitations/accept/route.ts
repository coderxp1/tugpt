import { isSameOriginMutation, readJsonRecord } from '@/lib/http/mutations';
/**
 * POST /api/v1/invitations/accept
 *
 * The invitee's side. Takes the plaintext token from their link, and joins
 * them to the organization it names.
 *
 * NO x-tenant-id, AND THAT IS THE POINT
 *
 * Every other route in this API resolves an active organization first and
 * scopes the work to it. This one cannot: the caller is not yet a member of
 * the organization they are joining, so there is no tenant context to resolve.
 * The token carries the organization, and the RPC reads it from the locked
 * invitation row.
 *
 * That makes this the one route where the request body, not the session,
 * determines which tenant is touched — which is exactly why the token is a
 * 244-bit server-generated secret and why presenting the stored hash does not
 * work (see 20260902000001).
 *
 * WHAT COMES BACK MAY NOT BE THE INVITED ROLE
 *
 * Accepting an invitation never rewrites an existing membership. Someone who
 * is already in the organization at `agent` and accepts an `admin` invitation
 * stays an `agent`. The response returns the role they actually hold, so the
 * screen cannot show a permission set they do not have.
 */

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { AuthService } from '@tugpt/auth';
import { mapDraftRpcError } from '@/lib/draft-api/error-mapper';
import type { ApiError } from '@/lib/draft-api/types';

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return privateJson(body, { status });
}

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return errorResponse(403, 'FORBIDDEN', 'Same-origin JSON request required');
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;

  try {
    const supabase = await createAuthenticatedServerClient();
    const authService = new AuthService(supabase);
    const user = await authService.getCurrentUser();

    // Signing in first is required, and is the reason `anon` needs no access
    // to the invitations table at all.
    if (!user) return errorResponse(401, 'UNAUTHENTICATED', 'Sign in to accept this invitation');

    let body: { token?: unknown };
    try {
      body = await readJsonRecord(request, ["token"]);
    } catch {
      return errorResponse(400, 'INVALID_BODY', 'Invalid JSON request body');
    }

    if (typeof body.token !== 'string' || body.token.trim() === '' || body.token.length > 512) {
      return errorResponse(400, 'INVALID_BODY', 'token is required');
    }

    const { data, error: rpcError } = await (
      supabase as unknown as {
        rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
      }
    ).rpc('accept_invitation', { p_token: body.token });

    if (rpcError) {
      const mapped = mapDraftRpcError(rpcError as { code?: string });
      // No organization id: at this point there may not be one the caller is
      // entitled to, and logging the one from a rejected token would record a
      // tenant the request never legitimately reached.
      defaultLogger.warn('Invitation accept RPC failed', {
        requestId,
        sqlstateCode: (rpcError as { code?: string }).code,
        httpStatus: mapped.status,
      });
      return errorResponse(mapped.status, mapped.code, mapped.code === 'VERIFIED_EMAIL_REQUIRED'
        ? 'Fresh verified email evidence is required. Continue through TuGPT sign-in and retry this explicit invitation action.'
        : mapped.message);
    }

    const result = data as { organization_id: string; membership_created: boolean; role: string };

    defaultLogger.info('Invitation accepted', {
      requestId,
      organizationId: result.organization_id,
      membershipCreated: result.membership_created,
      role: result.role,
    });

    return privateJson({ membership: result });
  } catch (err) {
    defaultLogger.error('Invitation accept failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}

/** Personalized/error responses must never enter a shared response cache. */
function privateJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'private, no-store');
  return NextResponse.json(body, { ...init, headers });
}
