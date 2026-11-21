/**
 * /dashboard — the TuGPT product hub.
 *
 * The proxy has already refused signed-out visitors (deny-by-default; see
 * proxy-route-coverage.test.ts). This page resolves the session and active
 * organization through the same cached resolver every layout uses, then reads
 * organization-scoped signals through the user's own RLS-bound client.
 *
 * It renders even when signals cannot be read: ordinary pages remain linked, and
 * unreadable figures say so instead of showing zero. Held products never open.
 */

import type { Metadata } from 'next';
import { createTranslator } from '@/i18n';
import { getRequestLocale } from '@/i18n/server';
import { getSessionContext } from '@/lib/tenant/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { loadHubSignals, UNAVAILABLE_SIGNALS, type HubSignals } from '@/lib/hub/signals';
import { resolveProducts } from '@/lib/hub/products';
import { ProductHub } from '@/components/hub/ProductHub';
import { loadOrgFeatures } from '@/lib/hub/features.server';
import { featureMap } from '@/lib/hub/features';

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
  const statuses = await loadOrgFeatures();

  return (
    <ProductHub
      organizationName={session?.tenant?.organizationName ?? null}
      fullName={session?.fullName ?? null}
      email={session?.email || null}
      role={role ? t.maybe(`hub.role.${role}`, role) : null}
      roleKey={role}
      features={featureMap(statuses)}
      statuses={statuses}
      products={resolveProducts(signals)}
      t={t}
    />
  );
}
