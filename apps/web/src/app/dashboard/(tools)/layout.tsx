/**
 * The dashboard's frame. Everything under /dashboard renders inside it.
 *
 * Until 2026-08-31 there was no shell at all: `/dashboard/drafts` rendered a
 * bare `<h1>` on an otherwise empty page, and `/auth/logout` was reachable only
 * by typing the URL. The Sep 11 milestone is "every page reachable without
 * typing a URL" — `tests/app-routes-reachable.test.ts` is that sentence made
 * checkable.
 *
 * The session is resolved here rather than in each page because the shell is
 * the only thing that needs it, and `getSessionContext` is `cache()`d, so the
 * root layout's locale lookup and this share one round trip.
 */

import { createTranslator } from '@/i18n';
import { getRequestLocale } from '@/i18n/server';
import { getSessionContext } from '@/lib/tenant/server';
import { AppShell } from '@/components/shell/AppShell';

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [session, locale] = await Promise.all([getSessionContext(), getRequestLocale()]);
  const t = createTranslator(locale);

  // `session` is null only when Supabase could not be reached, or the user
  // belongs to no organization — the proxy has already refused anyone who is
  // simply signed out. The shell renders either way: a header that cannot name
  // the organization is worth more than a page that will not load, and it says
  // so on screen rather than showing a blank where the name goes.
  return (
    <AppShell
      organizationName={session?.tenant?.organizationName ?? null}
      email={session?.email || null}
      t={t}
    >
      {children}
    </AppShell>
  );
}
