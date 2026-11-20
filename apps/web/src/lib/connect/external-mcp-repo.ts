/**
 * Customer-MCP repository. All mutations run through SECURITY DEFINER RPCs and
 * reads through the caller's RLS-bound client, so this works under the
 * SSO/PostgREST front where the service-role admin client refuses (A1/A2).
 * The DB remains the authorization authority: owner/admin role is enforced in
 * every RPC, membership in every read.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { TypedSupabaseClient } from '@tugpt/database';

export type PermissionClass = 'read' | 'write' | 'irreversible' | 'financial';

export interface ExternalToolEndpoint {
  readonly id: string;
  readonly url: string;
  readonly displayName: string;
  readonly status: 'pending' | 'active' | 'disabled';
  readonly snapshot: { readonly id: string; readonly toolCount: number; readonly approved: boolean } | null;
}

export interface ExternalToolListEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export interface ExternalToolWithPermission {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly permissionClass: PermissionClass;
}

export interface RecordedApproval {
  readonly id: string;
  readonly expiresAt: string;
}

/** Thrown by repository methods on a PostgREST error; pgCode is the SQLSTATE. */
export class RepoError extends Error {
  constructor(public readonly pgCode: string, message: string) { super(message); }
}

/** activate_mcp_endpoint refused: the newest snapshot is not approved or is revoked (SQLSTATE PT409). HTTP 409. */
export class ActivationDeniedError extends Error {
  constructor() { super('the newest tool snapshot must be approved and not revoked'); this.name = 'ActivationDeniedError'; }
}

/** The endpoint does not exist in this organization (the RPC returned false). HTTP 404. */
export class EndpointNotFoundError extends Error {
  constructor() { super('MCP endpoint not found'); this.name = 'EndpointNotFoundError'; }
}

/** SQLSTATE + message activate_mcp_endpoint raises when the snapshot gate refuses (20261120000008). */
export const ACTIVATION_DENIED_SQLSTATE = 'PT409';
export const ACTIVATION_DENIED_MESSAGE = 'SNAPSHOT_NOT_APPROVED';

export interface ExternalMcpRepository {
  createEndpoint(orgId: string, userId: string, url: string, displayName: string): Promise<{ id: string }>;
  /** null ONLY when no such endpoint exists in this org (F-M9-1). Throws DatabaseTimeoutError when the lookup
   * could not be answered (timeout, lock, transport, PostgREST/database error) and RepoError('42501') when the
   * caller lacks the owner/admin role. */
  getEndpointUrl(orgId: string, endpointId: string): Promise<string | null>;
  getEndpoint(orgId: string, endpointId: string): Promise<{ id: string; url: string } | null>;
  /** Activation gate: true only when the NEWEST snapshot is approved and not revoked. Throws RepoError('42501')
   * or DatabaseTimeoutError when the read fails (never reports a failed read as false). */
  hasApprovedSnapshot(orgId: string, endpointId: string): Promise<boolean>;
  listEndpoints(orgId: string): Promise<ExternalToolEndpoint[]>;
  getLatestSnapshotVersion(orgId: string, endpointId: string): Promise<number>;
  /** M9: idempotent create keyed by (endpoint, Idempotency-Key); version assigned by the database. */
  createSnapshotIdempotent(orgId: string, endpointId: string, idempotencyKey: string, contentSha256: string, tools: readonly ExternalToolListEntry[], deadlineIso: string): Promise<IdempotentSnapshotResult>;
  /** M9: committed | in_progress | not_found for a key; never blocks on a running request. */
  getSnapshotRequest(orgId: string, endpointId: string, idempotencyKey: string): Promise<SnapshotRequestStatus>;
  getSnapshot(orgId: string, snapshotId: string): Promise<{ id: string; approvedAt: string | null } | null>;
  listSnapshotTools(orgId: string, snapshotId: string): Promise<ExternalToolWithPermission[]>;
  approveSnapshot(orgId: string, snapshotId: string, tools: readonly { name: string; permissionClass: PermissionClass }[]): Promise<void>;
  /** Database-gated (20261120000008). Throws ActivationDeniedError (newest snapshot not approved / revoked),
   * EndpointNotFoundError, RepoError('42501'), or DatabaseTimeoutError for anything else; never resolves unless
   * the row was actually set to active. */
  activateEndpoint(orgId: string, endpointId: string): Promise<void>;
  deactivateEndpoint(orgId: string, endpointId: string): Promise<void>;
  deleteEndpoint(orgId: string, endpointId: string): Promise<void>;
  recordApproval(orgId: string, connectionId: string, capability: string, argumentsSha256: string, ttlSeconds: number, threadId: string): Promise<RecordedApproval>;
  revokeApproval(orgId: string, approvalId: string): Promise<boolean>;
}

/** SQLSTATE the snapshot RPCs raise when a lock other than the endpoint row is not available within
 * lock_timeout (e.g. DDL on external_tools). PostgREST answers HTTP 503; the client does not retry a POST.
 * (The legacy key-less create_mcp_snapshot and its PT409 version-conflict mapping were removed in F-M9-2;
 * 20261120000007 revokes the function from every API role.) */
export const SNAPSHOT_BUSY_SQLSTATE = 'PT503';

/** The snapshot store is briefly locked by something other than a concurrent snapshot; retry later. */
export class SnapshotStoreBusyError extends Error {
  constructor() { super('snapshot store busy'); this.name = 'SnapshotStoreBusyError'; }
}

/** The app gave up waiting for PostgREST (POSTGREST_REQUEST_TIMEOUT_MS). The database may still finish the
 * statement, so the outcome is unknown: callers must re-read before retrying, never assume nothing happened. */
export class DatabaseTimeoutError extends Error {
  constructor() { super('database request timed out'); this.name = 'DatabaseTimeoutError'; }
}

/**
 * True for the error postgrest-js returns when OUR fetch was aborted: no SQLSTATE and a message starting with
 * the DOMException name. AbortSignal.timeout() rejects with "TimeoutError" (postgrest-js 2.112.3 treats only
 * "AbortError" as an abort, so it reports a TimeoutError as a network error); a manual abort is "AbortError".
 * A database error always carries a SQLSTATE, so it never matches.
 */
export function isTransportTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code !== undefined && code !== null && code !== '') return false;
  return typeof message === 'string' && /^(TimeoutError|AbortError)\b/.test(message);
}

/** M9: result of create_mcp_snapshot_idempotent; replayed = the key was already committed (original returned). */
export interface IdempotentSnapshotResult {
  readonly snapshotId: string;
  readonly version: number;
  readonly toolCount: number;
  readonly replayed: boolean;
}

export type SnapshotRequestStatus =
  | { readonly state: 'committed'; readonly snapshotId: string; readonly version: number; readonly toolCount: number }
  | { readonly state: 'in_progress' }
  | { readonly state: 'not_found' };

/** Client Idempotency-Key format; the database enforces the same CHECK (20261120000006). */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** Another request with the same Idempotency-Key is still running (PT409 SNAPSHOT_REQUEST_IN_PROGRESS). */
export class SnapshotRequestInProgressError extends Error {
  constructor() { super('snapshot request in progress'); this.name = 'SnapshotRequestInProgressError'; }
}
/** A different snapshot of the same endpoint held the endpoint row past lock_timeout (PT503 SNAPSHOT_ENDPOINT_BUSY).
 * Nothing was written; retrying with the same key is safe. */
export class SnapshotEndpointBusyError extends Error {
  constructor() { super('snapshot endpoint busy'); this.name = 'SnapshotEndpointBusyError'; }
}
/** The write did not finish before its deadline and was rolled back (PT504). Nothing was written. */
export class SnapshotDeadlineExceededError extends Error {
  constructor() { super('snapshot deadline exceeded'); this.name = 'SnapshotDeadlineExceededError'; }
}
/** The endpoint does not exist in this organization (P0002). */
export class SnapshotEndpointNotFoundError extends Error {
  constructor() { super('MCP endpoint not found'); this.name = 'SnapshotEndpointNotFoundError'; }
}
/** The key or the tool list was rejected by the database (22023). */
export class SnapshotRequestInvalidError extends Error {
  constructor(public readonly reason: string) { super('invalid snapshot request'); this.name = 'SnapshotRequestInvalidError'; }
}

type PgError = { code?: string; message?: string };
/** Map an idempotent-snapshot RPC error to a typed error. Unknown errors become a plain Error (-> 500). */
function idempotentRpcError(error: PgError, fallback: string): Error {
  const code = error.code;
  const msg = error.message ?? '';
  if (code === 'PT409') return new SnapshotRequestInProgressError();
  if (code === 'PT503') return msg.includes('SNAPSHOT_ENDPOINT_BUSY') ? new SnapshotEndpointBusyError() : new SnapshotStoreBusyError();
  if (code === 'PT504') return new SnapshotDeadlineExceededError();
  if (code === 'P0002') return new SnapshotEndpointNotFoundError();
  if (code === '22023') return new SnapshotRequestInvalidError(msg.includes('INVALID_TOOLS') ? 'INVALID_TOOLS' : 'INVALID_IDEMPOTENCY_KEY');
  if (isTransportTimeout(error)) return new DatabaseTimeoutError();
  return new Error(fallback);
}

/**
 * F-M9-1: the endpoint lookup failed, so whether the endpoint exists is unknown. Only a NULL answer means "not
 * found"; treating an error as null turned a locked table or a timed-out request into 404 NOT_FOUND, which
 * made the UI drop its Idempotency-Key. 42501 is the RPC's owner/admin check (403). Everything else (our fetch
 * timed out or was aborted, 55P03 lock_not_available from the 2 s lock_timeout, 57014, a network failure,
 * PostgREST unable to reach the database, any other SQLSTATE) is reported as DatabaseTimeoutError, which every
 * caller maps to a retryable 503 DATABASE_TIMEOUT.
 */
export function endpointLookupError(error: PgError): Error {
  if (error?.code === '42501') return new RepoError('42501', 'not permitted to read this endpoint');
  return new DatabaseTimeoutError();
}

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- single cast for not-yet-generated tables/RPCs */
type Untyped = {
  from(table: string): any;
  rpc(fn: string, args: object): any;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export function createExternalMcpRepository(db: SupabaseClient | TypedSupabaseClient): ExternalMcpRepository {
  const u = db as unknown as Untyped;

  return {
    async createEndpoint(orgId, _userId, url, displayName) {
      const { data, error } = await u.rpc('register_mcp_endpoint', {
        p_organization_id: orgId, p_url: url, p_display_name: displayName,
      });
      if (error || typeof data !== 'string') throw new Error('failed to register the MCP endpoint');
      return { id: data };
    },

    async getEndpointUrl(orgId, endpointId) {
      // A malformed id cannot name an endpoint: genuinely missing, no database round trip.
      if (!isUuid(endpointId)) return null;
      const { data, error } = await u.rpc('get_mcp_endpoint_url', { p_organization_id: orgId, p_endpoint_id: endpointId });
      if (error) throw endpointLookupError(error as PgError);
      if (data === null || data === undefined) return null; // the RPC's NULL: no such endpoint in this org
      if (typeof data !== 'string') throw new Error('invalid endpoint lookup result');
      return data;
    },

    async getEndpoint(orgId, endpointId) {
      const url = await this.getEndpointUrl(orgId, endpointId);
      return url ? { id: endpointId, url } : null;
    },

    async hasApprovedSnapshot(orgId, endpointId) {
      // The activation pre-check (the database enforces the same rule since 20261120000008). Only the NEWEST snapshot
      // (highest version) counts, and it must be approved and not revoked. Reading just that one row means any
      // number of older versions can no longer trip maybeSingle() (PGRST116 used to become a false 409), a newer
      // unreviewed discovery cannot hide behind an older approval, and a revoked list never counts.
      // A failed read is never "not approved": 42501 -> RepoError (403), anything else -> DatabaseTimeoutError (503).
      const { data, error } = await u
        .from('external_tool_snapshots')
        .select('version,approved_at,revoked_at')
        .eq('organization_id', orgId)
        .eq('endpoint_id', endpointId)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw endpointLookupError(error as PgError);
      if (data === null || data === undefined) return false;
      if (typeof data !== 'object') throw new Error('invalid snapshot lookup result');
      const row = data as { approved_at?: unknown; revoked_at?: unknown };
      return typeof row.approved_at === 'string' && row.approved_at.length > 0 && (row.revoked_at === null || row.revoked_at === undefined);
    },

    async listEndpoints(orgId) {
      const { data, error } = await u.rpc('list_endpoints_admin', { p_organization_id: orgId });
      if (error || !Array.isArray(data)) throw new Error('failed to list MCP endpoints');
      return data as ExternalToolEndpoint[];
    },

    async getLatestSnapshotVersion(orgId, endpointId) {
      const { data, error } = await u
        .from('external_tool_snapshots')
        .select('version')
        .eq('organization_id', orgId)
        .eq('endpoint_id', endpointId)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();
      // Fail closed: a read error must not be mistaken for "no snapshots yet" (would retry v1).
      if (error) {
        if (isTransportTimeout(error)) throw new DatabaseTimeoutError();
        throw new Error('failed to read the latest snapshot version');
      }
      const v = data?.version;
      if (v === undefined || v === null) return 0;
      if (!Number.isInteger(v) || (v as number) < 1) throw new Error('invalid snapshot version');
      return v as number;
    },

    async createSnapshotIdempotent(orgId, endpointId, idempotencyKey, contentSha256, tools, deadlineIso) {
      const { data, error } = await u.rpc('create_mcp_snapshot_idempotent', {
        p_organization_id: orgId, p_endpoint_id: endpointId, p_idempotency_key: idempotencyKey,
        p_content_sha256: contentSha256,
        p_tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
        p_deadline: deadlineIso,
      });
      if (error) throw idempotentRpcError(error as PgError, 'failed to persist the tool snapshot');
      const d = data as { snapshot_id?: unknown; version?: unknown; tool_count?: unknown; replayed?: unknown } | null;
      if (!d || !isUuid(d.snapshot_id) || !isPositiveInt(d.version) || typeof d.tool_count !== 'number' || typeof d.replayed !== 'boolean') {
        throw new Error('failed to persist the tool snapshot');
      }
      return { snapshotId: d.snapshot_id, version: d.version, toolCount: d.tool_count, replayed: d.replayed };
    },

    async getSnapshotRequest(orgId, endpointId, idempotencyKey) {
      const { data, error } = await u.rpc('get_mcp_snapshot_request', {
        p_organization_id: orgId, p_endpoint_id: endpointId, p_idempotency_key: idempotencyKey,
      });
      if (error) throw idempotentRpcError(error as PgError, 'failed to read the snapshot request');
      const d = data as { state?: unknown; snapshot_id?: unknown; version?: unknown; tool_count?: unknown } | null;
      if (d?.state === 'in_progress') return { state: 'in_progress' };
      if (d?.state === 'not_found') return { state: 'not_found' };
      if (d?.state === 'committed' && isUuid(d.snapshot_id) && isPositiveInt(d.version) && typeof d.tool_count === 'number') {
        return { state: 'committed', snapshotId: d.snapshot_id, version: d.version, toolCount: d.tool_count };
      }
      throw new Error('failed to read the snapshot request');
    },

    async getSnapshot(orgId, snapshotId) {
      const { data, error } = await u
        .from('external_tool_snapshots')
        .select('id, approved_at')
        .eq('id', snapshotId)
        .eq('organization_id', orgId)
        .maybeSingle();
      // M9: a timeout is not "not found" (that answered a misleading 404); other errors stay null.
      if (error && isTransportTimeout(error)) throw new DatabaseTimeoutError();
      if (error || !data) return null;
      return { id: data.id, approvedAt: data.approved_at ?? null };
    },

    async listSnapshotTools(orgId, snapshotId) {
      const { data, error } = await u
        .from('external_tools')
        .select('name, description, input_schema, permission_class')
        .eq('organization_id', orgId)
        .eq('snapshot_id', snapshotId)
        .order('name');
      if (error) {
        if (isTransportTimeout(error)) throw new DatabaseTimeoutError();
        throw new Error('failed to list snapshot tools');
      }
      const rows = Array.isArray(data) ? data : [];
      return rows.map((d) => ({ name: d.name, description: d.description, inputSchema: d.input_schema, permissionClass: d.permission_class }));
    },

    async approveSnapshot(orgId, snapshotId, tools) {
      const { error } = await u.rpc('approve_mcp_snapshot', {
        p_organization_id: orgId, p_snapshot_id: snapshotId,
        p_tools: tools.map((t) => ({ name: t.name, permissionClass: t.permissionClass })),
      });
      if (error) throw new Error('failed to approve the MCP snapshot');
    },

    async activateEndpoint(orgId, endpointId) {
      const { data, error } = await u.rpc('activate_mcp_endpoint', { p_organization_id: orgId, p_endpoint_id: endpointId });
      if (error) {
        const e = error as PgError;
        if (e?.code === ACTIVATION_DENIED_SQLSTATE && e?.message === ACTIVATION_DENIED_MESSAGE) throw new ActivationDeniedError();
        throw endpointLookupError(e);
      }
      if (data !== true) throw new EndpointNotFoundError();
    },

    async deactivateEndpoint(orgId, endpointId) {
      const { error } = await u.rpc('deactivate_mcp_endpoint', { p_organization_id: orgId, p_endpoint_id: endpointId });
      if (error) throw new Error('failed to deactivate the MCP endpoint');
    },

    async deleteEndpoint(orgId, endpointId) {
      const { error } = await u.rpc('delete_mcp_endpoint', { p_organization_id: orgId, p_endpoint_id: endpointId });
      if (error) throw new Error('failed to delete the MCP endpoint');
    },

    async recordApproval(orgId, connectionId, capability, argumentsSha256, ttlSeconds, threadId) {
      const { data, error } = await u.rpc('record_tool_approval', {
        p_organization_id: orgId, p_connection_id: connectionId, p_capability: capability,
        p_arguments_sha256: argumentsSha256, p_ttl_seconds: ttlSeconds, p_thread_id: threadId,
      });
      if (error) throw new RepoError(error.code ?? 'INTERNAL', error.message ?? 'failed to record the approval');
      const row = Array.isArray(data) ? data[0] : data;
      return { id: row.id, expiresAt: row.expires_at };
    },

    async revokeApproval(orgId, approvalId) {
      const { data, error } = await u.rpc('revoke_tool_approval', { p_organization_id: orgId, p_approval_id: approvalId });
      if (error) throw new RepoError(error.code ?? 'INTERNAL', error.message ?? 'failed to revoke the approval');
      return data === true;
    },
  };
}
