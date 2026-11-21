/**
 * Usage report contract (dashboard M2, migration 20261121700002).
 *
 * Customer-facing usage is about capabilities and quantities: which feature,
 * how many requests, how many tokens, how many failed. It never carries a
 * provider, model, endpoint, price or cost — those are internal accounting and
 * stay in `provider_usage_events` (service_role only). `public.org_usage_report`
 * is the only customer read path and enforces that in the database; these
 * types describe what it returns so the route and the screen agree.
 *
 * Scope: `self` (any member: only their own requests) or `organization`
 * (owner/admin: everything, with a per-user breakdown). The route picks the
 * default from the caller's role; the database is the authority and answers a
 * non-owner/admin asking for `organization` with P3S02 (403).
 */

export const USAGE_BUCKETS = ["day", "month"] as const;
export type UsageBucket = (typeof USAGE_BUCKETS)[number];

export const USAGE_SCOPES = ["organization", "self"] as const;
export type UsageScope = (typeof USAGE_SCOPES)[number];

/** Features a customer can recognise. `other` = legacy rows recorded before features were tracked. */
export type UsageFeature =
  "chat" | "agents" | "drafts" | "transcription" | "images" | "other";

export interface UsageTotals {
  requests: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  input_tokens: number;
  output_tokens: number;
  audio_seconds: number;
  /** Requests whose usage the provider did not report: counted, but contribute no tokens. */
  unmetered_requests: number;
  /** Requests whose token counts were estimated by TuGPT rather than reported. */
  estimated_usage_requests: number;
}

export interface UsageFeatureRow {
  feature: UsageFeature;
  requests: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  audio_seconds: number;
}

export interface UsageSeriesPoint {
  /** YYYY-MM-DD, the start of the bucket in the organization's time zone. */
  bucket_start: string;
  requests: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
}

export interface UsageUserRow {
  user_id: string;
  name: string | null;
  email: string | null;
  /** false for former members: their history is kept, not hidden. */
  is_member: boolean;
  requests: number;
  input_tokens: number;
  output_tokens: number;
}

export interface UsageReport {
  scope: UsageScope;
  bucket: UsageBucket;
  time_zone: string;
  window: { from: string; to: string };
  totals: UsageTotals;
  by_feature: UsageFeatureRow[];
  series: UsageSeriesPoint[];
  /** Only for scope=organization; null for self. */
  by_user: UsageUserRow[] | null;
  /** Requests with no attributable user (pre-M2 rows, background jobs). null for self. */
  unattributed_requests: number | null;
}

const ORG_WIDE_ROLES = new Set(["owner", "admin"]);

export type UsageQuery =
  | { ok: true; bucket: UsageBucket; scope: UsageScope }
  | { ok: false; message: string };

/**
 * Parse `?bucket=` and `?scope=`. Missing values get defaults: `day`, and
 * `organization` for owner/admin, `self` for everyone else. An explicit value
 * outside the closed sets is rejected rather than coerced.
 */
export function parseUsageQuery(
  params: URLSearchParams,
  role: string | null | undefined,
): UsageQuery {
  const rawBucket = params.get("bucket");
  const rawScope = params.get("scope");

  const bucket = rawBucket === null || rawBucket === "" ? "day" : rawBucket;
  if (!(USAGE_BUCKETS as readonly string[]).includes(bucket)) {
    return { ok: false, message: "Invalid bucket; use day or month" };
  }

  const defaultScope: UsageScope =
    role && ORG_WIDE_ROLES.has(role) ? "organization" : "self";
  const scope = rawScope === null || rawScope === "" ? defaultScope : rawScope;
  if (!(USAGE_SCOPES as readonly string[]).includes(scope)) {
    return { ok: false, message: "Invalid scope; use organization or self" };
  }

  return {
    ok: true,
    bucket: bucket as UsageBucket,
    scope: scope as UsageScope,
  };
}
