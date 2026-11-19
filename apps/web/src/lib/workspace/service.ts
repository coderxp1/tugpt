/**
 * How the Workspace UI talks to the Workspace backend (Agent 4, docs/workspace/backend-api.md).
 *
 * Every call goes through Agent 4's typed client (`@/lib/workspace-data/contracts`, vendored byte for
 * byte so the two branches merge cleanly). This module adds the one thing the UI needs on top: an
 * honest answer to "can this work here?". A route that is not deployed answers with Next's HTML 404
 * (the client reports `404 UNEXPECTED_RESPONSE`); a store or blob storage that is not configured
 * answers 503 with a code. Both are *unavailable*, which the UI shows as "not available in this
 * workspace yet" — never as an error the person caused, and never by pretending it worked.
 */
import { createWorkspaceClient, type WorkspaceClient, type WorkspaceResult } from '@/lib/workspace-data/contracts';
import type { MessageKey } from '@/i18n/types';

export type ServiceProblem = 'unavailable' | 'signedOut' | 'forbidden' | 'notFound' | 'network' | 'failed';
export type Failure = Extract<WorkspaceResult<unknown>, { ok: false }>;

let client: WorkspaceClient | null = null;

/** One client per page. Same-origin cookie auth; mutations carry the CSRF header (the client does it). */
export function workspaceApi(): WorkspaceClient {
  client ??= createWorkspaceClient((input, init) => fetch(input, init));
  return client;
}

/** Tests only: install a client built on a stubbed fetch, or reset to the default. */
export function setWorkspaceApi(next: WorkspaceClient | null): void { client = next; }

const NOT_DEPLOYED = new Set([404, 405, 501]);
const NOT_CONFIGURED = new Set(['STORE_UNAVAILABLE', 'STORAGE_NOT_CONFIGURED', 'STORAGE_UNAVAILABLE']);

export function problemOf(f: Pick<Failure, 'status' | 'error'>): ServiceProblem {
  if (f.error === 'NETWORK_ERROR') return 'network';
  if (NOT_DEPLOYED.has(f.status) && f.error === 'UNEXPECTED_RESPONSE') return 'unavailable';
  if (f.status === 503 && (NOT_CONFIGURED.has(f.error) || f.error === 'UNEXPECTED_RESPONSE')) return 'unavailable';
  if (f.status === 401) return 'signedOut';
  if (f.status === 403) return 'forbidden';
  if (f.status === 404) return 'notFound';
  return 'failed';
}

/**
 * Responses are checked before they are trusted: a route that exists on this server but predates
 * the contract (e.g. GET /api/v1/chat/threads without `nextCursor`) is treated as unavailable.
 */
export function hasArray<K extends string>(value: unknown, key: K): value is Record<K, unknown[]> {
  return typeof value === 'object' && value !== null && Array.isArray((value as Record<string, unknown>)[key]);
}

const MESSAGES: Partial<Record<string, MessageKey>> = {
  PAYLOAD_TOO_LARGE: 'workspace.err.tooLarge',
  UNSUPPORTED_MEDIA_TYPE: 'workspace.err.type',
  MEDIA_TYPE_MISMATCH: 'workspace.err.mismatch',
  INVALID_FILENAME: 'workspace.err.filename',
  ALREADY_EXISTS: 'workspace.err.exists',
  LIMIT_EXCEEDED: 'workspace.err.limit',
  TOO_MANY_PENDING: 'workspace.err.limit',
  TOO_MANY_CHUNKS: 'workspace.err.tooLarge',
  ALREADY_DECIDED: 'workspace.err.decided',
  REQUEST_EXPIRED: 'workspace.err.expired',
  QUERY_TOO_LONG: 'workspace.err.queryTooLong',
  INVALID_REQUEST: 'workspace.err.invalid',
  INVALID_MODEL: 'workspace.err.invalidModel',
  INVALID_COLLECTION: 'workspace.err.invalidCollection',
  CONFLICT: 'workspace.err.conflict',
  RATE_LIMITED: 'workspace.err.rateLimited',
  FORBIDDEN: 'workspace.err.forbidden',
  NOT_FOUND: 'workspace.err.notFound',
  STORAGE_NOT_CONFIGURED: 'workspace.err.storage',
  STORAGE_UNAVAILABLE: 'workspace.err.storage',
  INTEGRITY_CHECK_FAILED: 'workspace.err.integrity',
  NETWORK_ERROR: 'workspace.err.network',
};

/** A short, human sentence for a failed call. Never the raw code, never server text. */
export function messageKeyFor(f: Pick<Failure, 'status' | 'error'>): MessageKey {
  const p = problemOf(f);
  if (p === 'unavailable') return f.status === 503 ? 'workspace.err.storage' : 'workspace.err.unavailable';
  if (p === 'signedOut') return 'workspace.err.signedOut';
  return MESSAGES[f.error] ?? (p === 'forbidden' ? 'workspace.err.forbidden' : 'workspace.err.generic');
}
