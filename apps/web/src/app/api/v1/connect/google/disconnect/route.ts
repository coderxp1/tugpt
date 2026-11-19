/**
 * POST /api/v1/connect/google/disconnect
 *
 * Revoke the Google credential through the broker and mark the connection
 * revoked, then redirect to the settings page with a stable outcome.
 */

import { NextResponse } from 'next/server';
import { crossOriginMutationResponse } from '@/lib/http/mutations';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@tugpt/database';
import { AuthService } from '@tugpt/auth';
import { BrokerClient, disconnectProvider } from '@tugpt/connect-server';
import { settingsIntegrationsUrl } from '@/lib/google-integrations/redirect-uri';

const PROVIDER = 'google';

export async function POST(request: Request) {
  // CSRF/origin guard first: no session, DB, broker or egress work for a
  // cross-origin or non-JSON mutation (Agent 1 findings D7/X6).
  const csrf = crossOriginMutationResponse(request);
  if (csrf) return csrf;
  const fail = () => NextResponse.redirect(settingsIntegrationsUrl(request, { [PROVIDER]: 'error', reason: 'disconnect_failed' }));
  try {
    const supabase = await createAuthenticatedServerClient();
    const authService = new AuthService(supabase);
    const user = await authService.getCurrentUser();
    if (!user) return fail();
    const hint = request.headers.get('x-tenant-id') ?? new URL(request.url).searchParams.get('tenant');
    const tenant = await authService.resolveTenantContext(user.id, hint);
    if (!tenant || (tenant.role !== 'owner' && tenant.role !== 'admin')) return fail();

    const adminClient = createAdminSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    const brokerUrl = process.env.TUGPT_BROKER_URL;
    const brokerKeyHex = process.env.TUGPT_BROKER_CALLER_KEY;
    if (!brokerUrl || !brokerKeyHex) return fail();
    const broker = new BrokerClient({ baseUrl: brokerUrl, caller: 'web', key: Buffer.from(brokerKeyHex, 'hex') });

    await disconnectProvider({ db: adminClient, broker, provider: PROVIDER, organizationId: tenant.organizationId });
    return NextResponse.redirect(settingsIntegrationsUrl(request, { [PROVIDER]: 'revoked' }));
  } catch {
    return fail();
  }
}
