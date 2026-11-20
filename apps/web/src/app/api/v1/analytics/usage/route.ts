import { getRequestedTenantId } from "@/lib/tenant/request";
/**
 * GET /api/v1/analytics/usage
 *
 * Usage v2 (dashboard M2, migration 20261121700002): requests and tokens by
 * feature, over time and — for owners/admins — by person. Query:
 *   range  = 7d | 30d | 90d          (default 30d)
 *   bucket = day | month             (default day; buckets in the org time zone)
 *   scope  = organization | self     (default organization for owner/admin, else self)
 *
 * WHY THE RPC IS CALLED ON THE USER'S CLIENT, NOT AN ADMIN CLIENT
 *
 * `public.org_usage_report` derives the caller from `auth.uid()` inside the
 * definer: membership (P3J02 for non-members and nonexistent/deleted orgs
 * alike, so ids cannot be enumerated), the scope rule (P3S02 when a
 * non-owner/admin asks for the whole organization) and the `self` filter all
 * hang off it. A service-role client would hollow every one of those out. The
 * route picks a sensible default scope from the role it already resolved; the
 * database stays the authority.
 *
 * WHAT IT NEVER RETURNS
 *
 * Provider, model, endpoint, price or cost. Those are internal accounting
 * (estimated and actual cost live side by side in provider_usage_events,
 * service_role only). The previous version of this route returned them via
 * `org_usage_summary`, which is no longer callable by customers.
 */

import { NextResponse } from "next/server";
import { defaultLogger } from "@tugpt/observability";
import { createAuthenticatedServerClient } from "@/lib/supabase/server";
import { AuthService } from "@tugpt/auth";
import { mapDraftRpcError } from "@/lib/draft-api/error-mapper";
import { resolveUsageWindow } from "@/lib/analytics/window";
import {
  parseUsageQuery,
  type UsageReport,
} from "@/lib/analytics/usage-report";
import type { ApiError } from "@/lib/draft-api/types";

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return privateJson(body, { status });
}

export async function GET(request: Request) {
  const requestId = request.headers.get("x-request-id") || `req-${Date.now()}`;
  const rawTenantId = getRequestedTenantId(request.headers);

  try {
    const supabase = await createAuthenticatedServerClient();
    const authService = new AuthService(supabase);
    const user = await authService.getCurrentUser();

    if (!user) {
      return errorResponse(401, "UNAUTHENTICATED", "Authentication required");
    }

    const activeTenant = await authService.resolveTenantContext(
      user.id,
      rawTenantId,
    );
    if (!activeTenant) {
      return errorResponse(403, "FORBIDDEN", "No active organization found");
    }

    const params = new URL(request.url).searchParams;
    const window = resolveUsageWindow(params.get("range"), new Date());
    if (window === null) {
      return errorResponse(
        400,
        "INVALID_QUERY",
        "Invalid range; use 7d, 30d or 90d",
      );
    }
    const query = parseUsageQuery(params, activeTenant.role);
    if (!query.ok) {
      return errorResponse(400, "INVALID_QUERY", query.message);
    }

    const { data, error } = await supabase.rpc("org_usage_report", {
      p_organization_id: activeTenant.organizationId,
      p_from: window.from,
      p_to: window.to,
      p_bucket: query.bucket,
      p_scope: query.scope,
    } as unknown as undefined);

    if (error) {
      const mapped = mapDraftRpcError(error as { code?: string });
      defaultLogger.warn("Usage report RPC failed", {
        requestId,
        organizationId: activeTenant.organizationId,
        scope: query.scope,
        sqlstateCode: (error as { code?: string }).code,
        httpStatus: mapped.status,
      });
      return errorResponse(mapped.status, mapped.code, mapped.message);
    }

    const report = (data as unknown as UsageReport | null) ?? null;

    defaultLogger.info("Usage report retrieved", {
      requestId,
      organizationId: activeTenant.organizationId,
      range: window.range,
      scope: query.scope,
      bucket: query.bucket,
      requests: report?.totals?.requests ?? 0,
    });

    return privateJson({
      range: window.range,
      window: { from: window.from, to: window.to },
      scope: query.scope,
      bucket: query.bucket,
      report,
    });
  } catch (err) {
    defaultLogger.error("Usage report failed", err as Error, { requestId });
    return errorResponse(500, "INTERNAL_ERROR", "An unexpected error occurred");
  }
}

/** Personalized/error responses must never enter a shared response cache. */
function privateJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "private, no-store");
  return NextResponse.json(body, { ...init, headers });
}
