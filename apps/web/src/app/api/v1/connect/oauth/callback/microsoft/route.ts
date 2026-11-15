/**
 * GET /api/v1/connect/oauth/callback/microsoft
 *
 * Microsoft returns the admin's browser here with `code` and `state`. The
 * organization comes from the signed state (never a query parameter), the
 * completing session must be the state's user, and the single-use pending
 * authorization is consumed before the exchange. The credential is stored
 * through the broker (v2); the route redirects to the settings page with a
 * stable reason slug.
 */

import { NextResponse } from 'next/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@tugpt/database';
import { AuthService } from '@tugpt/auth';
import { BrokerClient, completeMicrosoftConnectOAuth } from '@tugpt/connect-server';
import { publicAppOrigin, settingsIntegrationsUrl } from '@/lib/google-integrations/redirect-uri';

const CONNECT_CALLBACK_PATH = '/api/v1/connect/oauth/callback/microsoft';

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const code = params.get('code');
  const state = params.get('state');
  const fail = (reason: string) =>
    NextResponse.redirect(settingsIntegrationsUrl(request, { microsoft: 'error', reason }));

  if (!code || !state) {
    return fail('invalid_callback');
  }

  try {
    const supabase = await createAuthenticatedServerClient();
    const authService = new AuthService(supabase);
    const user = await authService.getCurrentUser();
    if (!user) {
      return fail('forbidden');
    }

    const adminClient = createAdminSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    const brokerUrl = process.env.TUGPT_BROKER_URL;
    const brokerKeyHex = process.env.TUGPT_BROKER_CALLER_KEY;
    if (!brokerUrl || !brokerKeyHex) {
      return fail('not_configured');
    }
    const broker = new BrokerClient({
      baseUrl: brokerUrl,
      caller: 'web',
      key: Buffer.from(brokerKeyHex, 'hex'),
    });

    const redirectUri = `${publicAppOrigin(request)}${CONNECT_CALLBACK_PATH}`;
    await completeMicrosoftConnectOAuth({
      db: adminClient,
      broker,
      oauth: { client: adminClient, env: process.env },
      code,
      state,
      redirectUri,
      userId: user.id,
    });

    return NextResponse.redirect(settingsIntegrationsUrl(request, { microsoft: 'connected' }));
  } catch {
    return fail('internal_error');
  }
}
