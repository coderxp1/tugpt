/**
 * Root route.
 *
 * Until 2026-08-24 this was the untouched create-next-app boilerplate — a
 * Next.js logo, "To get started, edit the page.tsx file", and a "Deploy Now"
 * button pointing at Vercel. Nobody noticed because nothing linked to it and
 * the app had never been served from a domain anyone would type by hand. The
 * moment the site went live it became the first thing a visitor saw, on a
 * project that had just retired Vercel.
 *
 * There is no landing page to show yet and inventing one here would be scope,
 * so `/` sends people where they were going anyway: the reviewer inbox. The
 * proxy takes it from there — /dashboard is a protected route, so a signed-out
 * visitor is bounced to /auth/login?redirect=/dashboard/inbox and lands back
 * on the inbox once they authenticate.
 *
 * Until 2026-09-01 this pointed at /dashboard/drafts, which the comment above
 * has always called "the inbox" for want of anything better. There is now an
 * actual inbox — a list of conversations, which is what a reviewer arrives
 * wanting — so the word means one thing again and `/` points at it.
 *
 * Redirecting to the inbox rather than straight to /auth/login is deliberate:
 * an already-signed-in reviewer goes directly to work instead of touching a
 * login page that would only bounce them onward.
 *
 * Since 2026-11-01 `/` points at the Dashboard hub (/dashboard), the product
 * hub every signed-in person lands on; the inbox is one product inside it.
 *
 * Since 2026-11-16 `/` points at the Workspace (/workspace): product decision 4 of the
 * Dashboard / Workspace split makes the Workspace the landing page after login. The Dashboard
 * stays one click away (Workspace sidebar and top bar).
 *
 * When a real landing page exists, replace this — and remember that `/` is
 * classified `public` in proxy.ts, so whatever replaces it is served to
 * anyone who asks. See proxy-route-coverage.test.ts.
 */

import { redirect } from 'next/navigation';

export default function RootPage(): never {
  redirect('/workspace');
}
