/**
 * Per-user, per-organization fixed-window limits (20261120100003). The policy
 * (max, window) is server configuration in private.workspace_rate_limit_policies;
 * the API only names the action. Consumed after authentication and cheap input
 * validation, before the expensive work.
 */
import { check, type WorkspaceDb } from './db';
import { WorkspaceError } from './errors';

export type RateLimitedAction = 'file.upload' | 'library.search' | 'document.reindex' | 'agent.run' | 'agent.write';

/** Throws 429 RATE_LIMITED (with retryAfterSeconds for the Retry-After header) when the window is exhausted. */
export async function consumeRateLimit(db: WorkspaceDb, organizationId: string, action: RateLimitedAction): Promise<void> {
  const data = check(await db.rpc('consume_workspace_rate_limit', { p_organization_id: organizationId, p_action: action }));
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
  if (!row || typeof row.allowed !== 'boolean') throw new WorkspaceError(503, 'STORE_UNAVAILABLE');
  if (row.allowed) return;
  const retry = typeof row.retry_after_seconds === 'number' && Number.isFinite(row.retry_after_seconds) ? row.retry_after_seconds : 60;
  throw new WorkspaceError(429, 'RATE_LIMITED', Math.max(1, Math.ceil(retry)));
}
