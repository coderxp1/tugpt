/**
 * Workspace persistence goes through the caller's own RLS-bound Supabase
 * client, exactly like lib/chat/store.ts. There is no service-role path in
 * this module: what a user can read or change is what the policies in
 * 20261119100001..04 and 20261120100001..05 allow. This interface is the subset of PostgREST the
 * Workspace code uses (a superset of ChatDb: it adds delete and range filters).
 */
import { WorkspaceError, type WorkspaceErrorCode } from './errors';

export interface DbError { readonly message?: string; readonly code?: string }
export interface DbResult { readonly data: unknown; readonly error: DbError | null }
export interface WsQuery extends PromiseLike<DbResult> {
  select(columns: string): WsQuery;
  eq(column: string, value: unknown): WsQuery;
  is(column: string, value: null): WsQuery;
  in(column: string, values: readonly unknown[]): WsQuery;
  lt(column: string, value: unknown): WsQuery;
  order(column: string, options: { ascending: boolean }): WsQuery;
  limit(n: number): WsQuery;
  single(): PromiseLike<DbResult>;
  maybeSingle(): PromiseLike<DbResult>;
}
export interface WorkspaceDb {
  from(table: string): {
    select(columns: string): WsQuery;
    insert(values: object): WsQuery;
    update(values: object): WsQuery;
    delete(): WsQuery;
  };
  rpc(fn: string, args: object): PromiseLike<DbResult>;
}
export function asWorkspaceDb(client: unknown): WorkspaceDb { return client as WorkspaceDb; }

/** RAISE messages from the Workspace RPCs that are safe to show to the client as codes. */
const PUBLIC_DB_CODES: ReadonlySet<string> = new Set<WorkspaceErrorCode>([
  'FORBIDDEN', 'NOT_FOUND', 'QUERY_TOO_LONG', 'QUERY_REQUIRED', 'INVALID_THREAD', 'INVALID_ENDPOINT', 'INVALID_CAPABILITY',
  'INVALID_ARGUMENTS_HASH', 'INVALID_PREVIEW', 'INVALID_REASON', 'INVALID_DECISION', 'INVALID_NOTE', 'INVALID_TTL',
  'INVALID_SCOPE', 'INVALID_STATUS', 'ALREADY_DECIDED', 'REQUEST_EXPIRED', 'TOO_MANY_PENDING', 'TOO_MANY_CHUNKS',
  'TOO_MANY_COLLECTIONS', 'INVALID_STATUS_TRANSITION', 'FILE_CONTENT_IMMUTABLE', 'INVALID_REQUESTER',
  'INVALID_EMBEDDING', 'INVALID_ACTION',
]);

/** Map a PostgREST/Postgres error to a client-safe error. Never forwards raw DB text. */
export function dbError(error: DbError): WorkspaceError {
  const message = (error.message ?? '').trim();
  const known = PUBLIC_DB_CODES.has(message) ? (message as WorkspaceErrorCode) : undefined;
  switch (error.code) {
    case '42501': return new WorkspaceError(403, known ?? 'FORBIDDEN');
    case 'P0002': case 'PGRST116': case '23503': return new WorkspaceError(404, 'NOT_FOUND');
    case '22023': case '23514': case '22P02': return new WorkspaceError(400, known ?? 'INVALID_REQUEST');
    case '23505': return new WorkspaceError(409, 'ALREADY_EXISTS');
    case '55000': return new WorkspaceError(409, known ?? 'CONFLICT');
    case '54000': return new WorkspaceError(429, known ?? 'LIMIT_EXCEEDED');
    default: return new WorkspaceError(503, 'STORE_UNAVAILABLE');
  }
}

export function check(r: DbResult): unknown {
  if (r.error) throw dbError(r.error);
  return r.data;
}
export function rows(r: DbResult): unknown[] {
  const data = check(r);
  return Array.isArray(data) ? data : [];
}

const fail = (): never => { throw new WorkspaceError(503, 'STORE_UNAVAILABLE'); };
export const str = (v: unknown): string => (typeof v === 'string' ? v : fail());
export const optStr = (v: unknown): string | null => (v === null || v === undefined ? null : str(v));
export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : fail());
export const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail());
export function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T {
  const s = str(v);
  return (allowed as readonly string[]).includes(s) ? (s as T) : fail();
}
