/**
 * GET /api/v1/integrations/google/callback
 *
 * Google returns the admin's browser here with `code` and `state` (or
 * `error`). NOTHING in this request is trusted:
 *
 *   - The organization comes from the signed state — verified against
 *     the platform-vault HMAC secret — never from a query parameter.
 *   - The state also binds the user who started the flow; the session
 *     completing it must be that same user.
 *   - Membership and the owner/admin role are re-verified server-side
 *     for the state's organization BEFORE the code is exchanged, so a
 *     transplanted state buys an attacker nothing: without an admin
 *     session for that organization, no exchange happens and nothing is
 *     stored.
 *   - The state is consumed on first use (its hash is recorded in
 *     oauth_state_nonces before the exchange), so neither the state nor
 *     Google's single-use code can be replayed — a captured callback
 *     URL is spent the moment it is answered.
 *
 * Outcomes land on the fixed settings path with a stable reason code —
 * never a caller-supplied redirect, never internal detail. An answered
 * consent stores the credential in the organization's vault; it does
 * NOT enable the feature flag, so connecting and enabling stay separate
 * decisions.
 */

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@tugpt/database';
import { AuthService } from '@tugpt/auth';
import {
  completeGoogleOAuthCallback,
  verifyGoogleOAuthState,
  GoogleOAuthError,
  type GoogleOAuthDeps,
  type GoogleOAuthErrorCode,
} from '@tugpt/appointments';
import type { ApiError } from '@/lib/draft-api/types';
import {
  resolveGoogleRedirectUri,
  settingsIntegrationsUrl,
} from '@/lib/google-integrations/redirect-uri';

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status });
}

/** Stable, non-sensitive reason slugs for the settings page. */
const REASON_BY_CODE: Record<GoogleOAuthErrorCode, string> = {
  CONFIG_MISSING: 'not_configured',
  INVALID_STATE: 'invalid_state',
  INVALID_REDIRECT_URI: 'not_configured',
  EXCHANGE_FAILED: 'exchange_failed',
  NO_OFFLINE_ACCESS: 'no_offline_access',
  SCOPE_NOT_GRANTED: 'scope_not_granted',
  STORAGE_FAILED: 'storage_failed',
};

export async function GET(request: Request) {
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;
  const params = new URL(request.url).searchParams;

  const fail = (reason: string) =>
    NextResponse.redirect(
      settingsIntegrationsUrl(request, { google: 'error', reason })
    );

  try {
    // Google answered with an error instead of a code — most often the
    // admin declined consent. Nothing was granted; nothing to verify.
    const providerError = params.get('error');
    if (providerError !== null) {
      return NextResponse.redirect(
        settingsIntegrationsUrl(
          request,
          providerError === 'access_denied'
            ? { google: 'denied' }
            : { google: 'error', reason: 'provider_error' }
        )
      );
    }

    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) {
      return fail('invalid_callback');
    }

    const supabase = await createAuthenticatedServerClient();
    const authService = new AuthService(supabase);
    const user = await authService.getCurrentUser();
    if (!user) {
      // The code is single-use and cannot survive a login round trip;
      // the admin restarts the flow from settings. 401 follows the
      // /api/v1 convention for unauthenticated calls.
      return errorResponse(401, 'UNAUTHENTICATED', 'Authentication required');
    }

    const adminClient = createAdminSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    const deps = { client: adminClient } as unknown as GoogleOAuthDeps;

    // Verify first, exchange second: membership and role are checked
    // against the state's organization before Google sees the code.
    let organizationId: string;
    try {
      const verified = await verifyGoogleOAuthState(deps, state);
      if (verified.userId !== user.id) {
        return fail('invalid_state');
      }
      organizationId = verified.organizationId;
    } catch (err) {
      if (err instanceof GoogleOAuthError) {
        return fail(REASON_BY_CODE[err.code]);
      }
      throw err;
    }

    const tenant = await authService.resolveTenantContext(user.id, organizationId);
    if (!tenant || (tenant.role !== 'owner' && tenant.role !== 'admin')) {
      return fail('forbidden');
    }

    try {
      const result = await completeGoogleOAuthCallback(deps, {
        code,
        state,
        redirectUri: resolveGoogleRedirectUri(request),
        expectedUserId: user.id,
      });
      defaultLogger.info('Google Calendar connected', {
        requestId,
        organizationId: result.organizationId,
      });
      return NextResponse.redirect(
        settingsIntegrationsUrl(request, { google: 'connected' })
      );
    } catch (err) {
      if (err instanceof GoogleOAuthError) {
        defaultLogger.warn('Google Calendar connection refused', {
          requestId,
          organizationId,
          code: err.code,
        });
        return fail(REASON_BY_CODE[err.code]);
      }
      throw err;
    }
  } catch (err) {
    defaultLogger.error('Google OAuth callback failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}
