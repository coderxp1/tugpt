/**
 * /settings/integrations — the page the Google OAuth flow returns to.
 *
 * Server component, no client JavaScript: the connect action is a link
 * to the start route, disconnect is a plain form POST, and the outcome
 * banners read the query parameters the OAuth routes redirect with.
 *
 * WHAT THIS PAGE NEVER SEES
 *
 * No token, no client secret, no provider error text. Connection state
 * comes from `getGoogleIntegrationStatus` (metadata: existence, scopes,
 * expiry), and failure banners render fixed copy keyed by the stable
 * reason slug in the URL — a slug outside the known set falls back to
 * the generic reason, so nothing an attacker puts in the query string
 * is ever echoed as text.
 */

import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@tugpt/database';
import { createTranslator, formatDateTime, type MessageKey } from '@/i18n';
import { getRequestLocale } from '@/i18n/server';
import { getSessionContext } from '@/lib/tenant/server';
import { getGoogleIntegrationStatus } from '@/lib/google-integrations/status';

/** Stable reason slug → copy. The full set the OAuth routes can emit. */
const REASON_KEYS: Readonly<Record<string, MessageKey>> = {
  not_configured: 'integrations.reason.not_configured',
  invalid_state: 'integrations.reason.invalid_state',
  invalid_callback: 'integrations.reason.invalid_callback',
  provider_error: 'integrations.reason.provider_error',
  forbidden: 'integrations.reason.forbidden',
  exchange_failed: 'integrations.reason.exchange_failed',
  no_offline_access: 'integrations.reason.no_offline_access',
  scope_not_granted: 'integrations.reason.scope_not_granted',
  storage_failed: 'integrations.reason.storage_failed',
  disconnect_failed: 'integrations.reason.disconnect_failed',
};

interface PageProps {
  searchParams: Promise<{ google?: string; reason?: string }>;
}

export default async function IntegrationsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const [session, locale] = await Promise.all([
    getSessionContext(),
    getRequestLocale(),
  ]);
  const t = createTranslator(locale);

  const banner = (kind: 'success' | 'info' | 'error', text: string) => (
    <p
      role={kind === 'error' ? 'alert' : 'status'}
      className={
        kind === 'error'
          ? 'rounded border border-red-300 bg-red-50 px-4 py-3 text-red-800'
          : kind === 'success'
            ? 'rounded border border-green-300 bg-green-50 px-4 py-3 text-green-800'
            : 'rounded border border-zinc-300 bg-zinc-50 px-4 py-3 text-zinc-700'
      }
    >
      {text}
    </p>
  );

  let outcome: React.ReactNode = null;
  if (params.google === 'connected') {
    outcome = banner('success', t('integrations.banner.connected'));
  } else if (params.google === 'denied') {
    outcome = banner('info', t('integrations.banner.denied'));
  } else if (params.google === 'revoked') {
    outcome = banner('info', t('integrations.banner.revoked'));
  } else if (params.google === 'error') {
    const reasonKey =
      REASON_KEYS[params.reason ?? ''] ?? 'integrations.reason.internal_error';
    outcome = banner(
      'error',
      t('integrations.banner.error', { reason: t(reasonKey) })
    );
  }

  const tenant = session?.tenant ?? null;

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-10">
      <h1 className="text-2xl font-semibold text-zinc-900">
        {t('integrations.title')}
      </h1>

      {outcome}

      {tenant === null ? (
        <p className="text-zinc-600">{t('integrations.noOrganization')}</p>
      ) : (
        <GoogleSection
          organizationId={tenant.organizationId}
          role={tenant.role}
          locale={locale}
        />
      )}
    </main>
  );
}

async function GoogleSection({
  organizationId,
  role,
  locale,
}: {
  organizationId: string;
  role: string;
  locale: Parameters<typeof formatDateTime>[1];
}) {
  const t = createTranslator(locale);
  const authClient = await createAuthenticatedServerClient();
  const adminClient = createAdminSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  const status = await getGoogleIntegrationStatus(
    authClient,
    adminClient,
    organizationId
  );
  const isAdmin = role === 'owner' || role === 'admin';
  const startHref = `/api/v1/integrations/google/start?tenant=${organizationId}`;
  const disconnectAction = `/api/v1/integrations/google/disconnect?tenant=${organizationId}`;

  return (
    <section className="flex flex-col gap-4 rounded border border-zinc-200 p-6">
      <h2 className="text-lg font-medium text-zinc-800">
        {t('integrations.google.title')}
      </h2>
      <p className="text-zinc-600">{t('integrations.google.description')}</p>

      {!status.platformConfigured ? (
        <p className="text-zinc-600">{t('integrations.status.notConfigured')}</p>
      ) : status.connected ? (
        <>
          <p className="font-medium text-green-700">
            {t('integrations.status.connected')}
          </p>
          {status.credentialExpired ? (
            <p className="text-amber-700">
              {t('integrations.status.credentialExpired')}
            </p>
          ) : status.credentialExpiresAt !== null ? (
            <p className="text-zinc-600">
              {t('integrations.status.credentialExpires', {
                date: formatDateTime(status.credentialExpiresAt, locale),
              })}
            </p>
          ) : null}
        </>
      ) : (
        <p className="font-medium text-zinc-700">
          {t('integrations.status.notConnected')}
        </p>
      )}

      {status.connected ? (
        <p className="text-zinc-600">
          {status.freeBusyEnabled
            ? t('integrations.status.checksEnabled')
            : t('integrations.status.checksDisabled')}
        </p>
      ) : null}

      {status.platformConfigured && isAdmin ? (
        <div className="flex gap-3">
          <a
            href={startHref}
            className="rounded bg-zinc-900 px-4 py-2 text-white"
          >
            {status.connected
              ? t('integrations.action.reconnect')
              : t('integrations.action.connect')}
          </a>
          {status.connected ? (
            <form method="post" action={disconnectAction}>
              <button
                type="submit"
                className="rounded border border-zinc-300 px-4 py-2 text-zinc-700"
              >
                {t('integrations.action.disconnect')}
              </button>
            </form>
          ) : null}
        </div>
      ) : status.platformConfigured ? (
        <p className="text-zinc-500">{t('integrations.adminOnly')}</p>
      ) : null}
    </section>
  );
}
