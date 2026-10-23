/**
 * POST /api/v1/integrations/google/disconnect
 *
 * Disconnects the active organization's Google Calendar: revokes the
 * credential at Google best-effort and deletes it from the vault
 * unconditionally (see `revokeGoogleConnection`). Submitted by the
 * settings page's plain HTML form; answers with a redirect back to that
 * page, or the /api/v1 JSON envelope for the unauthenticated/forbidden
 * cases a form cannot act on anyway.
 *
 * The organization comes from the authenticated session — the
 * `x-tenant-id` header or `tenant` parameter is only the hint
 * `resolveTenantContext` validates — and disconnecting requires the
 * owner or admin role, exactly like connecting.
 */

import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@tugpt/database';
import { AuthService } from '@tugpt/auth';
import {
  revokeGoogleConnection,
  type GoogleOAuthDeps,
} from '@tugpt/appointments';
import type { ApiError } from '@/lib/draft-api/types';
import { settingsIntegrationsUrl } from '@/lib/google-integrations/redirect-uri';

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export async function POST(request: Request) {
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
        'Disconnecting Google Calendar requires the organization owner or admin role'
      );
    }

    const adminClient = createAdminSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const result = await revokeGoogleConnection(
      { client: adminClient } as unknown as GoogleOAuthDeps,
      { organizationId: tenant.organizationId }
    );

    defaultLogger.info('Google Calendar disconnect', {
      requestId,
      organizationId: tenant.organizationId,
      localDeleted: result.localDeleted,
      remoteRevoked: result.remoteRevoked,
    });

    return NextResponse.redirect(
      settingsIntegrationsUrl(
        request,
        result.localDeleted
          ? { google: 'revoked' }
          : { google: 'error', reason: 'disconnect_failed' }
      ),
      303
    );
  } catch (err) {
    defaultLogger.error('Google disconnect failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}
