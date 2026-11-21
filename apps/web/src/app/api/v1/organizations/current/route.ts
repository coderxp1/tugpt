/**
 * GET   /api/v1/organizations/current — the active organization: settings, the caller's
 *                              role, member counts and permission hints.
 * PATCH /api/v1/organizations/current — change name, locale or time zone.
 *
 * The write is `public.update_organization_settings` (20261121700001): owner or
 * admin only, validated, audited as `organization.update_settings` with a
 * before/after diff. Direct UPDATE on public.organizations is no longer
 * granted to `authenticated`, so this is the only customer path.
 */
import { defaultLogger } from '@tugpt/observability';
import { isSameOriginMutation, readJsonRecord } from '@/lib/http/mutations';
import {
  dashboardContext, errorResponse, isResponse, privateJson, requestIdOf, rpcErrorResponse, type Rpc,
} from '@/lib/dashboard-api/http';
import { organizationPermissions } from '@/lib/dashboard-api/permissions';

export const dynamic = 'force-dynamic';

const LOCALES = ['es', 'en'] as const;

export async function GET(request: Request) {
  const requestId = requestIdOf(request);
  try {
    const ctx = await dashboardContext(request);
    if (isResponse(ctx)) return ctx;
    const orgId = ctx.tenant.organizationId;

    const [{ data: org, error: orgError }, { data: members, error: memberError }] = await Promise.all([
      ctx.supabase.from('organizations').select('id, name, slug, locale, time_zone, created_at').eq('id', orgId).single(),
      ctx.supabase.from('organization_members').select('role').eq('organization_id', orgId),
    ]);
    if (orgError || !org || memberError) {
      defaultLogger.warn('Organization read failed', { requestId, organizationId: orgId });
      return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
    }

    const rows = (members ?? []) as { role: string }[];
    const o = org as { id: string; name: string; slug: string; locale: string; time_zone: string | null; created_at: string };
    return privateJson({
      organization: { id: o.id, name: o.name, slug: o.slug, locale: o.locale, timeZone: o.time_zone, createdAt: o.created_at },
      membership: { role: ctx.tenant.role },
      memberCount: rows.length,
      ownerCount: rows.filter((r) => r.role === 'owner').length,
      permissions: organizationPermissions(ctx.tenant.role),
    });
  } catch (err) {
    defaultLogger.error('Organization read failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}

export async function PATCH(request: Request) {
  if (!isSameOriginMutation(request)) return errorResponse(403, 'FORBIDDEN', 'Same-origin JSON request required');
  const requestId = requestIdOf(request);
  try {
    const ctx = await dashboardContext(request);
    if (isResponse(ctx)) return ctx;

    let body: { name?: unknown; locale?: unknown; timeZone?: unknown };
    try {
      body = await readJsonRecord(request, ['name', 'locale', 'timeZone']);
    } catch {
      return errorResponse(400, 'INVALID_BODY', 'Invalid JSON request body');
    }

    // Shape checks only. Length, blank names and IANA validity are the RPC's
    // (P3S03); a second copy here would drift.
    const changes: Record<string, string> = {};
    if ('name' in body) {
      if (typeof body.name !== 'string') return errorResponse(400, 'INVALID_BODY', 'name must be a string');
      changes.name = body.name;
    }
    if ('locale' in body) {
      if (typeof body.locale !== 'string' || !(LOCALES as readonly string[]).includes(body.locale)) {
        return errorResponse(400, 'INVALID_BODY', 'locale must be one of: es, en');
      }
      changes.locale = body.locale;
    }
    if ('timeZone' in body) {
      if (typeof body.timeZone !== 'string') return errorResponse(400, 'INVALID_BODY', 'timeZone must be an IANA zone name');
      changes.time_zone = body.timeZone;
    }
    if (Object.keys(changes).length === 0) return errorResponse(400, 'INVALID_BODY', 'Nothing to change');

    const { data, error } = await (ctx.supabase as unknown as Rpc).rpc('update_organization_settings', {
      p_organization_id: ctx.tenant.organizationId,
      p_changes: changes,
    });
    if (error) {
      defaultLogger.warn('Organization settings RPC failed', {
        requestId, organizationId: ctx.tenant.organizationId, sqlstateCode: (error as { code?: string }).code,
      });
      return rpcErrorResponse(error);
    }

    const r = data as { id: string; name: string; slug: string; locale: string; time_zone: string | null; changed: boolean };
    defaultLogger.info('Organization settings updated', {
      requestId, organizationId: ctx.tenant.organizationId, fields: Object.keys(changes), changed: r.changed,
    });
    return privateJson({
      organization: { id: r.id, name: r.name, slug: r.slug, locale: r.locale, timeZone: r.time_zone },
      changed: r.changed,
    });
  } catch (err) {
    defaultLogger.error('Organization settings update failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}
