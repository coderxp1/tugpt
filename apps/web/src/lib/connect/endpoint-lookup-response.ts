import { NextResponse } from 'next/server';
import { DatabaseTimeoutError, RepoError } from './external-mcp-repo';
import type { ApiError } from '@/lib/draft-api/types';

/**
 * F-M9-1: the response for an endpoint lookup that could not be answered, for routes that look an endpoint up
 * before acting on it (delete, activate, deactivate). 503 DATABASE_TIMEOUT (Retry-After: 2) when the database
 * did not answer, 403 FORBIDDEN for the RPC's role check; null for anything else (the route's own 500).
 * A genuine "no such endpoint" is a null result from the repository, which the route answers with 404 itself.
 */
export function endpointLookupFailure(err: unknown): Response | null {
  if (err instanceof DatabaseTimeoutError) {
    const body: ApiError = { error: { code: 'DATABASE_TIMEOUT', message: 'The database did not answer in time. Reload to see the current state, then retry' } };
    return NextResponse.json(body, { status: 503, headers: { 'retry-after': '2', 'cache-control': 'no-store' } });
  }
  if (err instanceof RepoError && err.pgCode === '42501') {
    const body: ApiError = { error: { code: 'FORBIDDEN', message: 'Managing this MCP endpoint requires the organization owner or admin role' } };
    return NextResponse.json(body, { status: 403, headers: { 'cache-control': 'no-store' } });
  }
  return null;
}
