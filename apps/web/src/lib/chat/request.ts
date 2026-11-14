/**
 * Shared request context for /api/v1/chat/*: authenticated user, strictly
 * resolved organization (a stale or foreign tenant hint is a 403, never a
 * silent fallback), and the user's RLS-bound client.
 */
import { NextResponse } from 'next/server';
import { AuthService, type TenantContext } from '@tugpt/auth';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { getRequestedTenantId } from '@/lib/tenant/request';
import { resolveSessionTenant } from '@/lib/tenant/resolve';
import { asChatDb, ChatStoreError, type ChatDb } from './store';

export const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store' } as const;

export function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers: PRIVATE_HEADERS });
}

export interface ChatRequestContext {
  readonly db: ChatDb;
  readonly userId: string;
  readonly tenant: TenantContext;
}

export async function chatContext(request: Request): Promise<ChatRequestContext | NextResponse> {
  try {
    const client = await createAuthenticatedServerClient();
    const auth = new AuthService(client);
    const user = await auth.getCurrentUser();
    if (!user) return jsonError(401, 'Unauthenticated');
    const { tenant, requestedTenantRejected } = await resolveSessionTenant(auth, user.id, getRequestedTenantId(request.headers));
    if (requestedTenantRejected || !tenant) return jsonError(403, 'Access denied');
    return { db: asChatDb(client), userId: user.id, tenant };
  } catch {
    return jsonError(503, 'Service unavailable');
  }
}

export function storeErrorResponse(e: unknown): NextResponse {
  if (e instanceof ChatStoreError) {
    if (e.code === 'NOT_FOUND') return jsonError(404, 'Not found');
    if (e.code === 'FORBIDDEN') return jsonError(403, 'Access denied');
  }
  return jsonError(503, 'Service unavailable');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export function validTimeZone(v: unknown): string {
  if (typeof v !== 'string' || v.length > 64) return 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: v }); return v; } catch { return 'UTC'; }
}
