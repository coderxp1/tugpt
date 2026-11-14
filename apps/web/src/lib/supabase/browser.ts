// Browser-side Supabase client using @supabase/ssr createBrowserClient.
// Stores the auth session in cookies (not localStorage), so the Next.js
// server can read the same session via the cookie-aware server client.

import { createBrowserClient } from '@supabase/ssr';
import { sessionCookieOptions } from './cookie-options';
import type { Database } from '@tugpt/database';
import type { TypedSupabaseClient } from '@tugpt/database';

let cachedClient: TypedSupabaseClient | null = null;

/**
 * Get or create the singleton browser Supabase client.
 * Uses @supabase/ssr's createBrowserClient which stores the session
 * in cookies instead of localStorage, enabling server-side session sharing.
 */
export function getBrowserClient(): TypedSupabaseClient {
  if (cachedClient) return cachedClient;

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

  cachedClient = createBrowserClient<Database>(supabaseUrl, supabaseKey, {
    cookieOptions: sessionCookieOptions(),
  }) as unknown as TypedSupabaseClient;
  return cachedClient;
}