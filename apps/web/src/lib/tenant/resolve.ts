/**
 * Which organization a server-rendered page acts for.
 *
 * Kept free of `next/*` imports so it can be unit-tested. `server.ts` wraps it
 * with the request plumbing.
 *
 * Why this exists: the proxy forwards the selected organization as
 * `x-tenant-id` (from the `tugpt_tenant_id` cookie or the header), and every
 * API route honors it through `AuthService.resolveTenantContext`. Server
 * components used to ignore it and always render the user's first
 * organization, so a page could show organization A while its buttons
 * (for example, connecting Google Calendar) acted on organization B.
 *
 * Rules:
 *  - A requested organization is used only if the user is an active member;
 *    membership is checked by `AuthService` against RLS-scoped rows.
 *  - If the requested organization is unknown or not a membership (a stale
 *    cookie after removal, or a forged header), the page falls back to the
 *    default organization and reports `requestedTenantRejected`. Pages must
 *    render something. API routes stay strict (403), so a rejected selection
 *    can never authorize a mutation.
 *  - Malformed values are treated as "nothing requested". They never reach
 *    the database.
 */

import type { TenantContext } from '@tugpt/auth';

export interface TenantResolver {
  resolveTenantContext(userId: string, requestedTenantId?: string | null): Promise<TenantContext | null>;
}

export interface ResolvedSessionTenant {
  readonly tenant: TenantContext | null;
  /** True when a selection was supplied but is not a valid membership. */
  readonly requestedTenantRejected: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Normalise a requested tenant id; returns null for absent or malformed input. */
export function normalizeRequestedTenantId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return UUID_RE.test(value) ? value.toLowerCase() : null;
}

export async function resolveSessionTenant(
  resolver: TenantResolver,
  userId: string,
  rawRequestedTenantId: string | null | undefined,
): Promise<ResolvedSessionTenant> {
  const requested = normalizeRequestedTenantId(rawRequestedTenantId);
  const malformed = rawRequestedTenantId != null && rawRequestedTenantId.trim() !== '' && requested === null;

  if (requested) {
    const selected = await resolver.resolveTenantContext(userId, requested);
    if (selected) return { tenant: selected, requestedTenantRejected: false };
  }

  const fallback = await resolver.resolveTenantContext(userId);
  return { tenant: fallback, requestedTenantRejected: requested !== null || malformed };
}
