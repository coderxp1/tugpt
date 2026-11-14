// Session cookie attributes shared by the browser, server and proxy Supabase clients.
//
// @supabase/ssr does not set `Secure` by default. On an HTTPS deployment the
// session cookie must never travel over plain HTTP, so it is marked Secure
// whenever the app is served over HTTPS. Local HTTP development (no TLS) keeps
// working because the flag is derived from the actual scheme, not hard-coded.

/** Pure decision, exported for tests. */
export function isSecureOrigin(origin: string | undefined | null): boolean {
  return typeof origin === 'string' && origin.trim().toLowerCase().startsWith('https://');
}

/** `Secure` for the current context: the page's scheme in the browser, the configured origin on the server. */
export function sessionCookieOptions(): { secure: boolean; sameSite: 'lax'; path: '/' } {
  const secure =
    typeof window !== 'undefined'
      ? window.location.protocol === 'https:'
      : isSecureOrigin(process.env.TUGPT_APP_ORIGIN) || isSecureOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
  return { secure, sameSite: 'lax', path: '/' };
}
