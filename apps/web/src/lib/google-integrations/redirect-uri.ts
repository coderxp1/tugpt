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
 *
 * Its ORIGIN is the public origin of the configured redirect URI when one
 * is pinned. Behind the reverse proxy, `request.url` carries the
 * container's bind address (the image sets HOSTNAME=0.0.0.0), so deriving
 * the settings URL from it sent users who had just completed consent to
 * `https://0.0.0.0:3000/settings/integrations` — observed on
 * dashboard.tugpt.pro on 2026-11-14. The pinned redirect URI is, by
 * construction, a public URL Google was allowed to send the browser to, so
 * its origin is the right one. It is operator configuration, never request
 * input, so this cannot become an open redirect.
 */

export const GOOGLE_CALLBACK_PATH = '/api/v1/integrations/google/callback';
export const SETTINGS_INTEGRATIONS_PATH = '/settings/integrations';

function configuredRedirectUri(): string | null {
  const configured = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  return configured !== undefined && configured.length > 0 ? configured : null;
}

export function resolveGoogleRedirectUri(request: Request): string {
  return configuredRedirectUri() ?? `${new URL(request.url).origin}${GOOGLE_CALLBACK_PATH}`;
}

/**
 * The public origin users should land on: the pinned redirect URI's origin
 * when it parses, otherwise the request's own origin (local development).
 */
export function publicAppOrigin(request: Request): string {
  const configured = configuredRedirectUri();
  if (configured !== null) {
    try {
      return new URL(configured).origin;
    } catch {
      // A malformed pin is caught by createGoogleConsent (fails closed);
      // here we fall back rather than throw inside an error path.
    }
  }
  return new URL(request.url).origin;
}

/** The settings page, with stable machine-readable outcome parameters. */
export function settingsIntegrationsUrl(
  request: Request,
  params: Readonly<Record<string, string>>
): string {
  const url = new URL(SETTINGS_INTEGRATIONS_PATH, publicAppOrigin(request));
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
