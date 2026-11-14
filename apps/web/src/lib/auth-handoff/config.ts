/** Disabled until the production identity/data configuration is approved. */
export function websiteLoginConfig() {
  if (process.env.TUGPT_WEBSITE_LOGIN_ENABLED !== 'true') return null;
  const auth = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!auth || auth !== process.env.TUGPT_WEBSITE_AUTH_URL) return null;
  try {
    const origin = new URL(process.env.TUGPT_APP_ORIGIN || '');
    const localTest = process.env.TUGPT_AUTH_LOOPBACK_TEST === 'true' &&
      origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname);
    if ((!localTest && origin.origin !== 'https://dashboard.tugpt.pro') || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return null;
    return { origin: origin.origin, authOrigin: new URL(auth).origin };
  } catch { return null; }
}
export function safeDashboardPath(value: string | null | undefined): string {
  // Only local Dashboard/module paths. No URLs, encoding, backslashes or fragments.
  if (!value || !/^\/(?:dashboard(?:\/[a-zA-Z0-9_-]+)*|settings\/integrations)$/.test(value)) return '/dashboard';
  return value;
}
export function privateHeaders() {
  return { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
}
