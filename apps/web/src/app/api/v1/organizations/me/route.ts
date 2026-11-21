/**
 * GET   /api/v1/organizations/me — the signed-in person: profile, active organization and role,
 *                    every organization they belong to.
 * PATCH /api/v1/organizations/me — change their own display name and interface language.
 *
 * The write goes through the caller's RLS-bound client against the existing
 * column grant UPDATE(full_name, avatar_url, preferred_locale) and own-row
 * policy on public.profiles (20261102000002). Email is not writable here: it
 * is the identity invitations are bound to and changes only through auth.
 */
import { AuthService } from '@tugpt/auth';
import { defaultLogger } from '@tugpt/observability';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { isSameOriginMutation, readJsonRecord } from '@/lib/http/mutations';
import { getRequestedTenantId } from '@/lib/tenant/request';
import { errorResponse, privateJson, requestIdOf } from '@/lib/dashboard-api/http';
import { organizationPermissions } from '@/lib/dashboard-api/permissions';

export const dynamic = 'force-dynamic';

const LOCALES = ['es', 'en'] as const;
const MAX_NAME = 120;
const PROFILE_COLUMNS = 'id, email, full_name, avatar_url, preferred_locale';

type ProfileRow = { id: string; email: string | null; full_name: string | null; avatar_url: string | null; preferred_locale: string | null };

function profileBody(p: ProfileRow) {
  return { id: p.id, email: p.email, fullName: p.full_name, avatarUrl: p.avatar_url, preferredLocale: p.preferred_locale };
}

export async function GET(request: Request) {
  const requestId = requestIdOf(request);
  try {
    const supabase = await createAuthenticatedServerClient();
    const auth = new AuthService(supabase);
    const user = await auth.getCurrentUser();
    if (!user) return errorResponse(401, 'UNAUTHENTICATED', 'Authentication required');

    const [{ data: profile, error }, organizations, active] = await Promise.all([
      supabase.from('profiles').select(PROFILE_COLUMNS).eq('id', user.id).single(),
      auth.getUserOrganizations(user.id),
      auth.resolveTenantContext(user.id, getRequestedTenantId(request.headers)),
    ]);
    if (error || !profile) {
      defaultLogger.warn('Profile read failed', { requestId });
      return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
    }

    return privateJson({
      profile: profileBody(profile as ProfileRow),
      activeOrganization: active
        ? { ...active, permissions: organizationPermissions(active.role) }
        : null,
      organizations,
    });
  } catch (err) {
    defaultLogger.error('Profile read failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}

export async function PATCH(request: Request) {
  if (!isSameOriginMutation(request)) return errorResponse(403, 'FORBIDDEN', 'Same-origin JSON request required');
  const requestId = requestIdOf(request);
  try {
    const supabase = await createAuthenticatedServerClient();
    const auth = new AuthService(supabase);
    const user = await auth.getCurrentUser();
    if (!user) return errorResponse(401, 'UNAUTHENTICATED', 'Authentication required');

    let body: { fullName?: unknown; preferredLocale?: unknown };
    try {
      body = await readJsonRecord(request, ['fullName', 'preferredLocale']);
    } catch {
      return errorResponse(400, 'INVALID_BODY', 'Invalid JSON request body');
    }

    const changes: { full_name?: string | null; preferred_locale?: string } = {};
    if ('fullName' in body) {
      if (body.fullName === null) changes.full_name = null;
      else if (typeof body.fullName === 'string' && body.fullName.trim().length <= MAX_NAME) {
        changes.full_name = body.fullName.trim() || null;
      } else return errorResponse(400, 'INVALID_BODY', `fullName must be a string of at most ${MAX_NAME} characters`);
    }
    if ('preferredLocale' in body) {
      if (typeof body.preferredLocale !== 'string' || !(LOCALES as readonly string[]).includes(body.preferredLocale)) {
        return errorResponse(400, 'INVALID_BODY', 'preferredLocale must be one of: es, en');
      }
      changes.preferred_locale = body.preferredLocale;
    }
    if (Object.keys(changes).length === 0) return errorResponse(400, 'INVALID_BODY', 'Nothing to change');

    const { data, error } = await supabase
      .from('profiles')
      .update(changes as never)
      .eq('id', user.id)
      .select(PROFILE_COLUMNS)
      .single();
    if (error || !data) {
      defaultLogger.warn('Profile update failed', { requestId, sqlstateCode: (error as { code?: string } | null)?.code });
      return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
    }

    defaultLogger.info('Profile updated', { requestId, fields: Object.keys(changes) });
    return privateJson({ profile: profileBody(data as ProfileRow) });
  } catch (err) {
    defaultLogger.error('Profile update failed', err as Error, { requestId });
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
}
