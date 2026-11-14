// Cookie-aware Supabase server client for Next.js route handlers and server components.
// Uses @supabase/ssr createServerClient to read auth session from request cookies,
// so server-side code shares the same session as the browser.

import { cookies } from 'next/headers';
import { createServerClient as createSSRClient } from '@supabase/ssr';
import { sessionCookieOptions } from './cookie-options';
import type { TypedSupabaseClient, Database } from '@tugpt/database';

/**
 * Create a cookie-aware Supabase client for use in Next.js server contexts
 * (route handlers, server components, server actions).
 *
 * Reads the auth session from the request cookies set by the @supabase/ssr
 * browser client, so `supabase.auth.getUser()` resolves the authenticated user.
 *
 * Must be called per-request (async) because `cookies()` is async in Next.js 16.
 */
export async function createAuthenticatedServerClient(): Promise<TypedSupabaseClient> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl) {
    throw new Error(
      'Supabase URL is missing. Ensure NEXT_PUBLIC_SUPABASE_URL environment variable is set.'
    );
  }
  if (!supabaseKey) {
    throw new Error(
      'Supabase Key is missing. Ensure NEXT_PUBLIC_SUPABASE_ANON_KEY environment variable is set.'
    );
  }

  const cookieStore = await cookies();

  return createSSRClient<Database>(supabaseUrl, supabaseKey, {
    cookieOptions: sessionCookieOptions(),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // The `setAll` method was called from a Server Component, which
          // cannot set cookies. This can be ignored if you have middleware
          // refreshing the user's session.
        }
      },
    },
  }) as unknown as TypedSupabaseClient;
}