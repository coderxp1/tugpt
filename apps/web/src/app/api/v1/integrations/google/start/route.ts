/**
 * GET /api/v1/integrations/google/start
 *
 * Begins the organization-level Google Calendar connection: mints a
 * signed OAuth state and redirects the admin's browser to Google's
 * consent screen. The callback half is ../callback/route.ts.
 *
 * WHO MAY START, AND FOR WHICH ORGANIZATION
 *
 * The organization is resolved from the AUTHENTICATED session — the
 * `x-tenant-id` header or `tenant` query parameter is only the hint
 * `resolveTenantContext` validates against membership, exactly like the
 * other /api/v1 routes. Connecting a calendar that will answer for the
 * whole organization requires the owner or admin role; a member, agent,
 * or viewer gets 403 and no state is minted for them.
 *
 * Until an operator provisions TuGPT's Google OAuth client and the
 * state-signing secret in the platform vault, this route answers
 * 503 GOOGLE_NOT_CONFIGURED. That is the intended disabled state, not an
 * error path: the integration is dark until it is configured, and
 * nothing here invents a credential to light it up.
 */

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@tugpt/database';
import { AuthService } from '@tugpt/auth';
import {
  createGoogleConsent,
  GoogleOAuthError,
  type GoogleOAuthDeps,
} from '@tugpt/appointments';
import type { ApiError } from '@/lib/draft-api/types';
import { resolveGoogleRedirectUri } from '@/lib/google-integrations/redirect-uri';

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export async function GET(request: Request) {
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;

  try {
    const supabase = await createAuthenticatedServerClient();
    const authService = new AuthService(supabase);
    const user = await authService.getCurrentUser();

    if (!user) {
      return errorResponse(401, 'UNAUTHENTICATED', 'Authentication required');
    }

    const hint =
      request.headers.get('x-tenant-id') ??
      new URL(request.url).searchParams.get('tenant');
    const tenant = await authService.resolveTenantContext(user.id, hint);
    if (!tenant) {
      return errorResponse(403, 'FORBIDDEN', 'No active organization found');
    }
    if (tenant.role !== 'owner' && tenant.role !== 'admin') {
      return errorResponse(
        403,
        'FORBIDDEN',
        'Connecting Google Calendar requires the organization owner or admin role'
      );
    }

    const adminClient = createAdminSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    try {
      const consent = await createGoogleConsent(
        { client: adminClient } as unknown as GoogleOAuthDeps,
        {
          organizationId: tenant.organizationId,
          userId: user.id,
          redirectUri: resolveGoogleRedirectUri(request),
        }
      );
      defaultLogger.info('Google Calendar consent started', {
        requestId,
        organizationId: tenant.organizationId,
      });
      return NextResponse.redirect(consent.url);
    } catch (err) {
      if (err instanceof GoogleOAuthError) {
        if (err.code === 'CONFIG_MISSING' || err.code === 'INVALID_REDIRECT_URI') {
          // Not provisioned (or the redirect URI is unusable): the
          // integration is disabled, and the response says so without
          // leaking which vault entry is missing.
          return errorResponse(
            503,
            'GOOGLE_NOT_CONFIGURED',
            'Google Calendar integration is not configured'
          );
        }
      }
      throw err;
    }
  } catch (err) {
    defaultLogger.error('Google consent start failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}
