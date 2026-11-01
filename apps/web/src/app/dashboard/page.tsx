/**
 * /dashboard — the TuGPT product hub.
 *
 * The proxy has already refused signed-out visitors (deny-by-default; see
 * proxy-route-coverage.test.ts). This page resolves the session and active
 * organization through the same cached resolver every layout uses, then reads
 * organization-scoped signals through the user's own RLS-bound client.
 *
 * It renders even when signals cannot be read: every product still opens, and
 * unreadable figures say so instead of showing zero.
 */

import type { Metadata } from 'next';
import { createTranslator } from '@/i18n';
import { getRequestLocale } from '@/i18n/server';
import { getSessionContext } from '@/lib/tenant/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { loadHubSignals, UNAVAILABLE_SIGNALS, type HubSignals } from '@/lib/hub/signals';
import { resolveProducts } from '@/lib/hub/products';
import { ProductHub } from '@/components/hub/ProductHub';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = createTranslator(await getRequestLocale());
  return { title: `${t('hub.metaTitle')} · TuGPT` };
}

export default async function DashboardHubPage() {
  const [session, locale] = await Promise.all([getSessionContext(), getRequestLocale()]);
  const t = createTranslator(locale);

  let signals: HubSignals = UNAVAILABLE_SIGNALS;
  if (session?.tenant) {
    try {
      const db = await createAuthenticatedServerClient();
      signals = await loadHubSignals(db, session.tenant.organizationId);
    } catch {
      signals = UNAVAILABLE_SIGNALS;
    }
  }

  const role = session?.tenant?.role ?? null;

  return (
    <ProductHub
      organizationName={session?.tenant?.organizationName ?? null}
      email={session?.email || null}
      role={role ? t.maybe(`hub.role.${role}`, role) : null}
      products={resolveProducts(signals)}
      t={t}
    />
  );
}
