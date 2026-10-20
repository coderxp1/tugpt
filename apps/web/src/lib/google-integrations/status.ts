/**
 * @file status.ts
 * @description What the integrations page may know about the Google
 * Calendar connection — metadata only, assembled from three sources
 * that each stay inside their own boundary:
 *
 *   - Platform configuration: an EXISTENCE check on platform_secrets
 *     via the service-role client. Only `secret_name` is selected; the
 *     ciphertext columns are never read, let alone rendered.
 *   - Connection state: the `organization_connected_accounts` RPC, the
 *     schema's purpose-built metadata function. It checks membership
 *     against `auth.uid()` itself and returns scopes/expiry — never the
 *     credential. Called with the caller's authenticated client.
 *   - Enablement: the `google_calendar_freebusy` flag via
 *     `is_feature_enabled` (service-role client), read-only. This page
 *     displays the flag; it never changes it.
 *
 * Every failure resolves to the closed state (not configured / not
 * connected / disabled): a status page that guesses "connected" on an
 * error would be worse than one that admits it cannot tell.
 */

import type { TypedSupabaseClient } from '@tugpt/database';
import {
  GOOGLE_CALENDAR_SECRET_NAME,
  GOOGLE_OAUTH_PROVIDER,
  GOOGLE_OAUTH_CLIENT_SECRET_NAME,
  GOOGLE_OAUTH_STATE_SECRET_NAME,
  GOOGLE_FREEBUSY_FLAG_KEY,
} from '@tugpt/appointments';

export interface GoogleIntegrationStatus {
  /** TuGPT's OAuth client + state secret are provisioned in the platform vault. */
  readonly platformConfigured: boolean;
  /** The organization has a stored Google credential. */
  readonly connected: boolean;
  /** When the stored credential's access token expires (metadata only). */
  readonly credentialExpiresAt: string | null;
  /** The stored credential reports itself expired. */
  readonly credentialExpired: boolean;
  /** The per-organization free/busy feature flag is on. */
  readonly freeBusyEnabled: boolean;
}

interface ConnectedAccountRow {
  provider: string;
  secret_name: string;
  scopes: string[];
  expires_at: string | null;
  is_expired: boolean;
}

export async function getGoogleIntegrationStatus(
  authClient: TypedSupabaseClient,
  adminClient: TypedSupabaseClient,
  organizationId: string
): Promise<GoogleIntegrationStatus> {
  const closed: GoogleIntegrationStatus = {
    platformConfigured: false,
    connected: false,
    credentialExpiresAt: null,
    credentialExpired: false,
    freeBusyEnabled: false,
  };

  try {
    const [platform, accounts, flag] = await Promise.all([
      (adminClient as unknown as {
        from: (t: string) => {
          select: (c: string) => {
            eq: (c: string, v: string) => {
              in: (c: string, v: string[]) => Promise<{ data: unknown; error: unknown }>;
            };
          };
        };
      })
        .from('platform_secrets')
        .select('secret_name')
        .eq('provider', GOOGLE_OAUTH_PROVIDER)
        .in('secret_name', [
          GOOGLE_OAUTH_CLIENT_SECRET_NAME,
          GOOGLE_OAUTH_STATE_SECRET_NAME,
        ]),
      (authClient as unknown as {
        rpc: (
          fn: string,
          args: Record<string, unknown>
        ) => Promise<{ data: unknown; error: unknown }>;
      }).rpc('organization_connected_accounts', {
        p_organization_id: organizationId,
      }),
      (adminClient as unknown as {
        rpc: (
          fn: string,
          args: Record<string, unknown>
        ) => Promise<{ data: unknown; error: unknown }>;
      }).rpc('is_feature_enabled', {
        p_organization_id: organizationId,
        p_flag_key: GOOGLE_FREEBUSY_FLAG_KEY,
      }),
    ]);

    const platformNames = new Set(
      (Array.isArray(platform.data) ? platform.data : []).map(
        (r) => (r as { secret_name?: unknown }).secret_name
      )
    );
    const platformConfigured =
      platform.error === null &&
      platformNames.has(GOOGLE_OAUTH_CLIENT_SECRET_NAME) &&
      platformNames.has(GOOGLE_OAUTH_STATE_SECRET_NAME);

    const rows = (
      accounts.error === null && Array.isArray(accounts.data) ? accounts.data : []
    ) as ConnectedAccountRow[];
    const credential = rows.find(
      (r) =>
        r.provider === GOOGLE_OAUTH_PROVIDER &&
        r.secret_name === GOOGLE_CALENDAR_SECRET_NAME
    );

    return {
      platformConfigured,
      connected: credential !== undefined,
      credentialExpiresAt: credential?.expires_at ?? null,
      credentialExpired: credential?.is_expired ?? false,
      freeBusyEnabled: flag.error === null && flag.data === true,
    };
  } catch {
    return closed;
  }
}
