import { isSameOriginMutation, readJsonRecord } from '@/lib/http/mutations';
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
      return privateJson(
        { error: 'Unauthenticated' },
        { status: 401 }
      );
    }

    // Server-side validation of active tenant
    const activeTenant = await authService.resolveTenantContext(user.id, rawTenantId);
    if (rawTenantId && (!activeTenant || activeTenant.organizationId !== rawTenantId)) {
      return privateJson(
        { error: 'Access denied to requested tenant' },
        { status: 403 }
      );
    }

    const orgs = await authService.getUserOrganizations(user.id);

    defaultLogger.info('Organizations list retrieved', {
      requestId,
      userId: user.id,
      count: orgs.length,
    });

    return privateJson({
      organizations: orgs,
      activeTenant,
      total: orgs.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    defaultLogger.error('Organizations list failed', err as Error, { requestId });
    return privateJson({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return privateJson({ error: 'Same-origin JSON request required' }, { status: 403 });
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;

  try {
    const supabase = await createAuthenticatedServerClient();
    const authService = new AuthService(supabase);
    const user = await authService.getCurrentUser();

    if (!user) {
      return privateJson(
        { error: 'Unauthenticated' },
        { status: 401 }
      );
    }

    let body: Record<string, unknown>;
    try { body = await readJsonRecord(request, ['name', 'slug']); }
    catch { return privateJson({ error: 'Invalid JSON body' }, { status: 400 }); }

    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 120 || typeof body.slug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(body.slug)) {
      return privateJson(
        { error: 'Missing required fields: name and slug' },
        { status: 400 }
      );
    }

    // Call public.create_organization_with_owner RPC
    // Args cast to unknown until supabase gen types is run to generate Database types.
    const { data: orgId, error: rpcError } = await supabase.rpc(
      'create_organization_with_owner',
      {
        p_name: body.name,
        p_slug: body.slug,
        p_owner_id: user.id,
      } as unknown as undefined
    );

    if (rpcError) {
      defaultLogger.error('Failed atomic organization creation RPC', rpcError, { requestId });
      return privateJson({ error: 'Failed to create organization' }, { status: 400 });
    }

    defaultLogger.info('Organization created successfully', {
      requestId,
      organizationId: orgId,
      userId: user.id,
    });

    return privateJson({
      success: true,
      organization: {
        id: orgId,
        name: body.name,
        slug: body.slug,
      },
    });
  } catch (err) {
    defaultLogger.error('Organization creation failed', err as Error, { requestId });
    return privateJson({ error: 'Internal Server Error' }, { status: 500 });
  }
}
/** Personalized/error responses must never enter a shared response cache. */
function privateJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'private, no-store');
  return NextResponse.json(body, { ...init, headers });
}
