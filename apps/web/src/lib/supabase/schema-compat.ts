/**
 * Expand/contract window for the Q-9c migrations (20261120200001..3).
 *
 * The Q-9c app reads agent instructions and message citations, and writes
 * assistant/tool messages, through database functions those migrations
 * create. To let the app be deployed BEFORE the migrations (so no version of
 * the app is ever broken during the rollout), each call falls back to the
 * pre-Q-9c query when, and only when, PostgREST reports that the function
 * itself does not exist (PGRST202).
 *
 * This does not weaken anything:
 * - On a database that has the migrations the functions exist, so the
 *   fallback is unreachable; a caller cannot make a function disappear.
 * - On a database that does not, the legacy query is exactly what the
 *   database already allows that caller (the column grants and the old
 *   INSERT policy are still in place there).
 * - Every other error, including 42501 permission denied, still fails closed.
 *
 * Remove this module and its callers' fallbacks (the "contract" step) once
 * every environment has applied 20261120200001..3. See
 * docs/workspace/operations.md section 1.
 */
export const MISSING_FUNCTION_CODE = 'PGRST202';

export function isMissingFunction(error: { code?: string } | null | undefined): boolean {
  return error?.code === MISSING_FUNCTION_CODE;
}

/**
 * Expand/contract window for 20261121100001 (Q-12 chat turns): on a database
 * without chat_messages.turn_id, PostgREST reports the column as unknown
 * (42703 on select, PGRST204 on insert). Callers then behave exactly as before
 * Q-12 (no turn ids, no de-duplication). Every other error still fails closed.
 */
export function isMissingColumn(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42703' || error?.code === 'PGRST204';
}

/**
 * Expand/contract window for 20261122100001 (Q-13 turn runs): on a database
 * without public.chat_turn_runs PostgREST reports the table as unknown
 * (PGRST205; 42P01 from older versions). The turn status then falls back to
 * the Q-12 rule (no run information). Every other error still fails closed.
 */
export function isMissingTable(error: { code?: string } | null | undefined): boolean {
  return error?.code === 'PGRST205' || error?.code === '42P01';
}
