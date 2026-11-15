/**
 * GET /api/v1/connect/microsoft/start
 *
 * Begins the Connect (v2) Microsoft 365 connection. On any failure the browser
 * is redirected back to the settings page with a stable, human-safe reason
 * (B-6) â€” never raw JSON, credentials, or OAuth details.
 */

import { NextResponse } from 'next/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@tugpt/database';
import { AuthService } from '@tugpt/auth';
import { startMicrosoftConnectOAuth } from '@tugpt/connect-server';
import { publicAppOrigin, settingsIntegrationsUrl } from '@/lib/google-integrations/redirect-uri';

const CONNECT_CALLBACK_PATH = '/api/v1/connect/oauth/callback/microsoft';

export async function GET(request: Request) {
  const fail = (reason: string) => NextResponse.redirect(settingsIntegrationsUrl(request, { microsoft: 'error', reason }));
  try {
    const supabase = await createAuthenticatedServerClient();
    const authService = new AuthService(supabase);
    const user = await authService.getCurrentUser();
    if (!user) return fail('forbidden');

    const hint = request.headers.get('x-tenant-id') ?? new URL(request.url).searchParams.get('tenant');
    const tenant = await authService.resolveTenantContext(user.id, hint);
    if (!tenant) return fail('forbidden');
    if (tenant.role !== 'owner' && tenant.role !== 'admin') return fail('forbidden');

    const adminClient = createAdminSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    const redirectUri = `${publicAppOrigin(request)}${CONNECT_CALLBACK_PATH}`;
    const result = await startMicrosoftConnectOAuth({
      db: adminClient,
      oauth: { client: adminClient, env: process.env },
      organizationId: tenant.organizationId,
      userId: user.id,
      redirectUri,
    });

    return NextResponse.redirect(result.url);
  } catch {
    return fail('not_configured');
  }
}
