/**
 * Shared plumbing for the Dashboard team/organization routes.
 *
 * Every route resolves the caller and the active organization through the
 * existing AuthService (no second identity system) and talks to Postgres with
 * the caller's own RLS-bound client. Authorization lives in the RPCs and RLS;
 * nothing here grants anything.
 */
import { NextResponse } from 'next/server';
import { AuthService, type AuthUser, type TenantContext } from '@tugpt/auth';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { getRequestedTenantId } from '@/lib/tenant/request';
import { mapDraftRpcError } from '@/lib/draft-api/error-mapper';
import type { ApiError } from '@/lib/draft-api/types';

/** Personalized/error responses must never enter a shared response cache. */
export function privateJson(body: unknown, init?: ResponseInit): NextResponse {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'private, no-store');
  return NextResponse.json(body, { ...init, headers });
}

export function errorResponse(status: number, code: string, message: string): NextResponse {
  const body: ApiError = { error: { code, message } };
  return privateJson(body, { status });
}

export function rpcErrorResponse(error: unknown): NextResponse {
  const mapped = mapDraftRpcError(error as { code?: string });
  return errorResponse(mapped.status, mapped.code, mapped.message);
}

export function requestIdOf(request: Request): string {
  return request.headers.get('x-request-id') || `req-${Date.now()}`;
}

type Supabase = Awaited<ReturnType<typeof createAuthenticatedServerClient>>;
export type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> };

export interface DashboardContext {
  readonly supabase: Supabase;
  readonly user: AuthUser;
  readonly tenant: TenantContext;
  readonly auth: AuthService;
}

/**
 * Authenticate and resolve the active organization, or return the response to
 * send instead (401 no session, 403 no/foreign organization).
 */
export async function dashboardContext(request: Request): Promise<DashboardContext | NextResponse> {
  const supabase = await createAuthenticatedServerClient();
  const auth = new AuthService(supabase);
  const user = await auth.getCurrentUser();
  if (!user) return errorResponse(401, 'UNAUTHENTICATED', 'Authentication required');
  const tenant = await auth.resolveTenantContext(user.id, getRequestedTenantId(request.headers));
  if (!tenant) return errorResponse(403, 'FORBIDDEN', 'No active organization found');
  return { supabase, user, tenant, auth };
}

export function isResponse(value: unknown): value is NextResponse {
  return value instanceof Response;
}
