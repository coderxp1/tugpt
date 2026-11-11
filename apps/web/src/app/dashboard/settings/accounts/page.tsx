/**
 * Account and access.
 *
 * Server component: the identity list is read from the session cookie the
 * proxy already validated, so this page cannot show identities for a user the
 * request is not authenticated as. Nothing here takes a user id from the URL.
 *
 * `redirect` rather than a thrown error when there is no user: the proxy
 * normally prevents this page from rendering signed out, but this handler is
 * also the one place a stale cookie can land, and an HTML 500 on a settings
 * page reads as a broken product rather than an expired session.
 */

import { redirect } from 'next/navigation';
import { createTranslator } from '@/i18n';
import { getRequestLocale } from '@/i18n/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { normalizeIdentities } from '@/lib/auth/identities';
import { LinkedAccounts } from '@/components/settings/LinkedAccounts';

// Nothing on this page is shareable between requests: it renders the
// signed-in user's own identities. Without this, a production build tries to
// prerender it with no request and no Supabase environment, and fails at the
// env check instead of bailing out of static rendering.
export const dynamic = 'force-dynamic';

const RETURN_TO = '/dashboard/settings/accounts';

export default async function AccountsPage() {
  // Locale first, deliberately: it reads cookies, and reading cookies is what
  // marks this route dynamic. `createAuthenticatedServerClient()` validates its
  // environment before it touches cookies, so calling it first would turn a
  // build-time prerender attempt into "Supabase URL is missing" instead of
  // letting Next bail out of static rendering.
  const locale = await getRequestLocale();
  const supabase = await createAuthenticatedServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/auth/login?redirect=${encodeURIComponent(RETURN_TO)}`);
  }

  const t = createTranslator(locale);
  const identities = normalizeIdentities(user.identities ?? []);

  return (
    <>
      <title>{`${t('accounts.title')} · TuGPT`}</title>
      <LinkedAccounts
        locale={locale}
        canonicalUserId={user.id}
        email={user.email ?? null}
        identities={identities}
        returnTo={RETURN_TO}
      />
    </>
  );
}
