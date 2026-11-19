/**
 * How long the server waits for one PostgREST request before giving up (AbortSignal.timeout).
 *
 * Database-side waits that a route must be able to report (for example create_mcp_snapshot's
 * lock_timeout) have to end at least DB_LOCK_BUDGET_MARGIN_MS before this, otherwise the app aborts
 * first and only sees a transport error (Agent 1, M4 re-test: lock_timeout 5 s vs this 5 s -> HTTP 500).
 * Guarded by timeouts.test.ts and pgTAP mcp_snapshot_versioning C7.
 */
export const POSTGREST_REQUEST_TIMEOUT_MS = 5000;
/** Headroom between a database lock budget and POSTGREST_REQUEST_TIMEOUT_MS (PostgREST, network, JWT, RLS). */
export const DB_LOCK_BUDGET_MARGIN_MS = 2000;
