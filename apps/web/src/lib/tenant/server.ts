/**
 * Who is asking, and on behalf of which organization.
 *
 * One resolver, wrapped in React `cache()`, so a request that needs the
 * locale (root layout), the organization name (app shell) and the reviewer's
 * email (app shell) pays for one round trip rather than three. Before this
 * existed, `i18n/server.ts` did the same work inline for the locale alone;
 * the shell would have been the second copy, and two copies of "which
 * organization is active" is two answers that can disagree.
 */

import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { AuthService, type TenantContext } from '@tugpt/auth';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { resolveSessionTenant } from './resolve';
import { getRequestedTenantId } from './request';

/** Cookie the organization switcher writes; the proxy mirrors it into `x-tenant-id`. */
export const ACTIVE_TENANT_COOKIE = 'tugpt_tenant_id';

export interface SessionContext {
  readonly userId: string;
  /** May be empty: Supabase permits users with no email on some providers. */
  readonly email: string;
  /** The person's own display name from their profile row; null when unset. */
  readonly fullName: string | null;
  /** Null when the user belongs to no organization. */
  readonly tenant: TenantContext | null;
  /**
   * True when the request selected an organization the user is not an active
   * member of. `tenant` is then the default organization, and API routes
   * will refuse the stale selection with 403.
   */
  readonly requestedTenantRejected: boolean;
}

/**
 * The organization this request asked for. One precedence rule shared with the
 * proxy and the API routes (`lib/tenant/request.ts`); a hint, never authority.
 */
async function requestedTenantId(): Promise<string | null> {
  return getRequestedTenantId(await headers());
}

/**
 * Is there any chance this request is authenticated?
 *
 * Only the opaque, host-only Dashboard session cookie counts. Legacy
 * `sb-*-auth-token` cookies are not session authority. Presence is a hint:
 * the session loader validates the cookie before anything is trusted.
 *
 * A wrong guess here degrades: the caller sees "not signed in" and renders the
 * default. It is not an authentication check and nothing downstream trusts it
 * — the proxy has already decided whether this request may see the page.
 */
async function hasSessionCookie(): Promise<boolean> {
  const store = await cookies();
  return store
    .getAll()
    .some((c) => c.name === '__Host-tugpt_session');
}

/**
 * The active session, or null when there isn't one.
 *
 * Never throws. Callers are layouts, which have to render something: a
 * language lookup or a header greeting must not be able to 500 a page, and
 * "signed out" is a state every caller here already handles. The proxy is what
 * keeps unauthenticated people off protected routes; this is presentation.
 */
export const getSessionContext = cache(async (): Promise<SessionContext | null> => {
  try {
    if (!(await hasSessionCookie())) return null;

    const supabase = await createAuthenticatedServerClient();

    // `auth.getUser()` directly rather than `AuthService.getCurrentUser()`:
    // the latter also reads the profiles row to assemble a display name, and
    // nothing here needs one yet.
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    // Same source and same membership check as the API routes, so a page and
    // the actions on it agree on which organization is active.
    const { tenant, requestedTenantRejected } = await resolveSessionTenant(
      new AuthService(supabase),
      user.id,
      await requestedTenantId(),
    );
    // The SSO bridge carries no email; the person's identity is their own
    // profile row (RLS: a user reads only their own). Never the organization's.
    let email = user.email ?? '';
    let fullName: string | null = null;
    try {
      const { data: profile } = await supabase.from('profiles').select('email, full_name').eq('id', user.id).maybeSingle();
      const row = profile as { email?: string | null; full_name?: string | null } | null;
      if (row?.email) email = row.email;
      fullName = row?.full_name?.trim() || null;
    } catch { /* profile is display-only; fall back to the bare session */ }
    return { userId: user.id, email, fullName, tenant, requestedTenantRejected };
  } catch {
    // Supabase unreachable, or its environment missing.
    return null;
  }
});
