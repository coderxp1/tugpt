import { getRequestedTenantId } from '@/lib/tenant/request';
import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { AuthService } from '@tugpt/auth';

export async function GET(request: Request) {
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;
  const rawTenantId = getRequestedTenantId(request.headers);

  try {
    const supabase = await createAuthenticatedServerClient();
    const authService = new AuthService(supabase);

    const user = await authService.getCurrentUser();

    if (!user) {
      defaultLogger.info('Session check: unauthenticated', { requestId });
      return privateJson(
        { authenticated: false, user: null, activeTenant: null },
        { status: 401 }
      );
    }

    // Resolve active tenant context server-side (validating user membership)
    const activeTenant = await authService.resolveTenantContext(user.id, rawTenantId);
    if (rawTenantId && !activeTenant) {
      return privateJson({ error: 'Access denied to requested tenant' }, { status: 403 });
    }

    defaultLogger.info('Session check: authenticated', {
      requestId,
      userId: user.id,
      tenantId: activeTenant?.organizationId || null,
    });

    return privateJson({
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        avatarUrl: user.avatarUrl,
      },
      activeTenant,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    defaultLogger.error('Session check failed', err as Error, { requestId });
    return privateJson({ error: 'Internal Server Error' }, { status: 500 });
  }
}
/** Personalized/error responses must never enter a shared response cache. */
function privateJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'private, no-store');
  return NextResponse.json(body, { ...init, headers });
}
