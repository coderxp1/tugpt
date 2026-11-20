/**
 * How long the server waits for one PostgREST request before giving up (AbortSignal.timeout).
 *
 * Database-side waits that a route must be able to report (for example create_mcp_snapshot's
 * lock_timeout) have to end at least DB_LOCK_BUDGET_MARGIN_MS before this, otherwise the app aborts
 * first and only sees a transport error (Agent 1, M4 re-test: lock_timeout 5 s vs this 5 s -> HTTP 500).
 * Guarded by timeouts.test.ts and pgTAP mcp_snapshot_versioning C7 / mcp_snapshot_idempotency I28-I30.
 */
export const POSTGREST_REQUEST_TIMEOUT_MS = 5000;
/** Headroom between a database lock budget and POSTGREST_REQUEST_TIMEOUT_MS (PostgREST, network, JWT, RLS). */
export const DB_LOCK_BUDGET_MARGIN_MS = 2000;

/**
 * Snapshot write deadline (M9). The route passes now + this as p_deadline to create_mcp_snapshot_idempotent,
 * which also caps it at statement_timestamp() + 3 s and checks it as the LAST step before returning: a write
 * that is still running at the deadline raises PT504 and rolls back. So the database only commits a snapshot
 * if its body finished before min(app deadline, statement start + 3 s), i.e. at least DB_LOCK_BUDGET_MARGIN_MS
 * before the app gives up at POSTGREST_REQUEST_TIMEOUT_MS. Residual window: commit + response delivery taking
 * longer than that margin (or app/DB clock skew); the Idempotency-Key replay covers it (never a duplicate).
 */
export const SNAPSHOT_WRITE_DEADLINE_MS = POSTGREST_REQUEST_TIMEOUT_MS - DB_LOCK_BUDGET_MARGIN_MS;

/** Message prefix of the error a timed-out PostgREST request produces (see asNonRetryableTimeout). */
export const DB_TIMEOUT_MESSAGE = `TimeoutError: database request exceeded ${POSTGREST_REQUEST_TIMEOUT_MS} ms`;

/**
 * Await a PostgREST fetch whose signal is AbortSignal.timeout(...), translating the timeout into an AbortError.
 *
 * Why (Agent 1, M9: GET reads took up to ~7.6 s): AbortSignal.timeout rejects with a DOMException named
 * "TimeoutError". postgrest-js 2.112.3 treats only "AbortError" as a cancellation; any other fetch error on
 * GET/HEAD/OPTIONS is retried up to 3 times (1/2/4 s back-off) and each retry gets a fresh 5 s timeout from our
 * wrapper, so one read could take far longer than POSTGREST_REQUEST_TIMEOUT_MS. An AbortError is never retried
 * and is reported as { code: '', message: 'AbortError: TimeoutError: ...' }, which isTransportTimeout() matches.
 * Errors that are not our timeout (DNS, refused, TLS) are rethrown unchanged.
 */
export async function asNonRetryableTimeout(signal: AbortSignal, request: Promise<Response>): Promise<Response> {
  try {
    return await request;
  } catch (err) {
    if (signal.aborted) throw new DOMException(DB_TIMEOUT_MESSAGE, 'AbortError');
    throw err;
  }
}
