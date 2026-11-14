// Independent opaque Dashboard session; no legacy Auth or privileged fallback.
import { cookies, headers as requestHeaders } from 'next/headers';
import { createSupabaseClient, type TypedSupabaseClient } from '@tugpt/database';
import { loadSession, bridgeToken, dbUrl, SsoError } from '@/lib/sso/core';
import { scopedFeatureAdapter } from '@/lib/sso/feature-adapter';

async function sessionForRequest() {
  // Raw headers retain duplicate cookies for the frozen parser to reject.
  const raw = (await requestHeaders()).get('cookie');
  const cookieHeader = raw ?? (await cookies()).getAll().map(c => `${c.name}=${c.value}`).join('; ');
  return loadSession(cookieHeader);
}

export async function createAuthenticatedServerClient(): Promise<TypedSupabaseClient> {
  const session = await sessionForRequest();
  const base = dbUrl(); // Missing configuration fails closed, never to legacy Auth.
  const client = createSupabaseClient(base, 'server-only-dashboard-adapter', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      if (!session?.mapped) {
        return Response.json({ code: '28000', message: 'Unauthenticated' }, { status: 401 });
      }
      const incoming = new Request(input, init);
      const url = new URL(incoming.url);
      if (url.origin !== base || !url.pathname.startsWith('/rest/v1/') || url.username || url.password || url.hash) {
        throw new SsoError(503, 'configuration_unavailable');
      }
      const headers = new Headers(incoming.headers);
      // Ordinary transport has no selectable SSO/control or private schema profile.
      for (const name of ['accept-profile', 'content-profile']) {
        if (headers.has(name) && headers.get(name) !== 'public') throw new SsoError(403, 'forbidden');
        headers.set(name, 'public');
      }
      headers.set('Authorization', 'Bearer ' + bridgeToken('authenticated', session));
      headers.delete('apikey');
      const outgoing = new Request(base + '/' + url.pathname.slice('/rest/v1/'.length) + url.search, incoming);
      return fetch(outgoing, {
        headers, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000),
      });
    } },
  });
  // Identity is from the verified server-side session only. Profile enrichment
  // continues through the ordinary RLS-bound AuthService, not a second Auth SDK.
  client.auth.getUser = async () => ({ data: { user: session ? {
    id: session.subject, email: '', user_metadata: {}, app_metadata: {},
    aud: 'authenticated', created_at: '',
  } : null }, error: null }) as Awaited<ReturnType<typeof client.auth.getUser>>;
  return client;
}

export async function createFeatureServerClient(organizationId: string): Promise<TypedSupabaseClient> {
  const session = await sessionForRequest();
  if (!session?.mapped) throw new SsoError(401, 'session_invalid');
  return scopedFeatureAdapter(session, organizationId);
}
