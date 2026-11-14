import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';

export type TypedSupabaseClient = SupabaseClient<Database>;

export function createSupabaseClient(
  supabaseUrl: string,
  supabaseKey: string,
  options?: Parameters<typeof createClient>[2]
): TypedSupabaseClient {
  if (!supabaseUrl) {
    throw new Error('Supabase URL is required to create a client instance.');
  }
  if (!supabaseKey) {
    throw new Error('Supabase key (anon/service-role) is required to create a client instance.');
  }
  return createClient<Database>(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
    ...options,
  });
}

export function createAdminSupabaseClient(
  supabaseUrl: string,
  serviceRoleKey: string
): TypedSupabaseClient {
  // Isolated SSO candidate: inherited privileged transports are not yet approved for the new identity boundary.
  if (process.env.TUGPT_DASHBOARD_POSTGREST_URL) {
    throw new Error('Privileged SSO adapter requires review; legacy admin transport disabled.');
  }
  if (typeof window !== 'undefined') {
    throw new Error('Security Violation: Cannot create an admin Supabase client in the browser environment.');
  }
  if (!supabaseUrl) {
    throw new Error('Supabase URL is required to create an admin client instance.');
  }
  if (!serviceRoleKey) {
    throw new Error('Supabase service role key is required to create an admin client instance.');
  }
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export function createServerClient(
  supabaseUrl?: string,
  supabaseKey?: string
): TypedSupabaseClient {
  const url = supabaseUrl || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = supabaseKey || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url) {
    throw new Error(
      'Database Client Error: Supabase URL is missing. Ensure NEXT_PUBLIC_SUPABASE_URL environment variable is set.'
    );
  }
  if (!key) {
    throw new Error(
      'Database Client Error: Supabase Key is missing. Ensure NEXT_PUBLIC_SUPABASE_ANON_KEY environment variable is set.'
    );
  }

  return createClient<Database>(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
