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
