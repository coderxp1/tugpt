/**
 * @file redirect-uri.ts
 * @description Where Google sends the browser back, and where the
 * browser goes after that — the two URLs the OAuth routes are built
 * from.
 *
 * The redirect URI must match the URI registered on TuGPT's Google
 * OAuth client EXACTLY, or Google refuses the flow. The operator can pin
 * it with GOOGLE_OAUTH_REDIRECT_URI; otherwise it is derived from the
 * request's own origin, which is correct for the deployment serving the
 * request and wrong only when a proxy rewrites hosts — exactly the case
 * the env override exists for. `createGoogleConsent` enforces https (or
 * http on localhost) either way, so a misconfigured origin fails closed
 * instead of sending a user to an insecure callback.
 *
 * The post-flow destination is a FIXED internal path. It is never taken
 * from a query parameter: an OAuth callback that redirects to a
 * caller-supplied URL is an open-redirect vulnerability wearing a login
 * flow's clothes.
 */

export const GOOGLE_CALLBACK_PATH = '/api/v1/integrations/google/callback';
export const SETTINGS_INTEGRATIONS_PATH = '/settings/integrations';

export function resolveGoogleRedirectUri(request: Request): string {
  const configured = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  return `${new URL(request.url).origin}${GOOGLE_CALLBACK_PATH}`;
}

/** The settings page, with stable machine-readable outcome parameters. */
export function settingsIntegrationsUrl(
  request: Request,
  params: Readonly<Record<string, string>>
): string {
  const url = new URL(SETTINGS_INTEGRATIONS_PATH, new URL(request.url).origin);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
