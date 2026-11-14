import { NextResponse } from 'next/server';
import { AuthService } from '@tugpt/auth';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { isSameOriginMutation, isRecord, isUuid, readSmallJson } from '@/lib/http/mutations';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

// Account-level recovery: a revoked/stale selection must not hide valid memberships.
export async function GET() {
  try {
    const auth = new AuthService(await createAuthenticatedServerClient());
    const user = await auth.getCurrentUser();
    if (!user) return NextResponse.json({ error: 'Unauthenticated' }, { status: 401, headers });
    return NextResponse.json({ organizations: await auth.getUserOrganizations(user.id) }, { headers });
  } catch { return NextResponse.json({ error: 'Service unavailable' }, { status: 503, headers }); }
}

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return NextResponse.json({ error: 'Invalid origin' }, { status: 403, headers });
  let body: unknown;
  try { body = await readSmallJson(request); } catch { return NextResponse.json({ error: 'Invalid request' }, { status: 400, headers }); }
  if (!isRecord(body) || Object.keys(body).some(key => key !== 'organizationId') || !isUuid(body.organizationId)) return NextResponse.json({ error: 'Invalid organization' }, { status: 400, headers });
  try {
    const auth = new AuthService(await createAuthenticatedServerClient());
    const user = await auth.getCurrentUser();
    if (!user) return NextResponse.json({ error: 'Unauthenticated' }, { status: 401, headers });
    const tenant = await auth.resolveTenantContext(user.id, body.organizationId);
    if (!tenant) return NextResponse.json({ error: 'Access denied' }, { status: 403, headers });
    const response = NextResponse.json({ activeTenant: tenant }, { headers });
    response.cookies.set('tugpt_tenant_id', tenant.organizationId, {
      httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 2592000,
    });
    return response;
  } catch { return NextResponse.json({ error: 'Service unavailable' }, { status: 503, headers }); }
}
