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

export interface ExternalMcpRepository {
  createEndpoint(orgId: string, userId: string, url: string, displayName: string): Promise<{ id: string }>;
  getEndpointUrl(orgId: string, endpointId: string): Promise<string | null>;
  getEndpoint(orgId: string, endpointId: string): Promise<{ id: string; url: string } | null>;
  hasApprovedSnapshot(orgId: string, endpointId: string): Promise<boolean>;
  listEndpoints(orgId: string): Promise<ExternalToolEndpoint[]>;
  createSnapshot(orgId: string, endpointId: string, version: number, contentSha256: string, tools: readonly ExternalToolListEntry[]): Promise<string>;
  getLatestSnapshotVersion(orgId: string, endpointId: string): Promise<number>;
  getSnapshot(orgId: string, snapshotId: string): Promise<{ id: string; approvedAt: string | null } | null>;
  listSnapshotTools(orgId: string, snapshotId: string): Promise<ExternalToolWithPermission[]>;
  approveSnapshot(orgId: string, snapshotId: string, tools: readonly { name: string; permissionClass: PermissionClass }[]): Promise<void>;
  activateEndpoint(orgId: string, endpointId: string): Promise<void>;
  deactivateEndpoint(orgId: string, endpointId: string): Promise<void>;
  deleteEndpoint(orgId: string, endpointId: string): Promise<void>;
  recordApproval(orgId: string, connectionId: string, capability: string, argumentsSha256: string, ttlSeconds: number, threadId: string): Promise<RecordedApproval>;
  revokeApproval(orgId: string, approvalId: string): Promise<boolean>;
}

/** The requested snapshot version is no longer latest+1 (a concurrent snapshot won). */
/** SQLSTATE of create_mcp_snapshot's version conflict; PostgREST maps PTxyz to HTTP xyz and never retries it. */
export const SNAPSHOT_CONFLICT_SQLSTATE = 'PT409';

export class SnapshotVersionConflictError extends Error {
  constructor() { super('snapshot version conflict'); this.name = 'SnapshotVersionConflictError'; }
}

/** SQLSTATE create_mcp_snapshot raises when a lock other than the endpoint row is not available within
 * lock_timeout (e.g. DDL on external_tools). PostgREST answers HTTP 503; the client does not retry a POST. */
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
      const { data, error } = await u.rpc('get_mcp_endpoint_url', { p_organization_id: orgId, p_endpoint_id: endpointId });
      if (error || typeof data !== 'string') return null;
      return data;
    },

    async getEndpoint(orgId, endpointId) {
      const url = await this.getEndpointUrl(orgId, endpointId);
      return url ? { id: endpointId, url } : null;
    },

    async hasApprovedSnapshot(orgId, endpointId) {
      const { data, error } = await u
        .from('external_tool_snapshots')
        .select('id')
        .eq('organization_id', orgId)
        .eq('endpoint_id', endpointId)
        .not('approved_at', 'is', null)
        .maybeSingle();
      if (error) return false;
      return data !== null;
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

    async createSnapshot(orgId, endpointId, version, contentSha256, tools) {
      const { data, error } = await u.rpc('create_mcp_snapshot', {
        p_organization_id: orgId, p_endpoint_id: endpointId, p_version: version, p_content_sha256: contentSha256,
        p_tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
      });
      if (error) {
        // create_mcp_snapshot raises PT409 when p_version is not latest+1 (concurrent or stale caller) or the
        // endpoint lock is busy (20261120000004). PT409 is deliberately NOT 40001: PostgREST re-runs 40001
        // transactions with the same arguments, which looped until the bridge JWT expired (Agent 1, M4).
        // 23505 is the UNIQUE (endpoint_id, version) backstop. Anything else is an internal error.
        // PT503 (20261120000005): a lock other than the endpoint row timed out -> busy, retry later.
        // A transport timeout means the app gave up first: the outcome is unknown (see DatabaseTimeoutError).
        const code = (error as { code?: string }).code;
        if (code === SNAPSHOT_CONFLICT_SQLSTATE || code === '23505') throw new SnapshotVersionConflictError();
        if (code === SNAPSHOT_BUSY_SQLSTATE) throw new SnapshotStoreBusyError();
        if (isTransportTimeout(error)) throw new DatabaseTimeoutError();
        throw new Error('failed to persist the tool snapshot');
      }
      if (typeof data !== 'string') throw new Error('failed to persist the tool snapshot');
      return data;
    },

    async getSnapshot(orgId, snapshotId) {
      const { data, error } = await u
        .from('external_tool_snapshots')
        .select('id, approved_at')
        .eq('id', snapshotId)
        .eq('organization_id', orgId)
        .maybeSingle();
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
      if (error) throw new Error('failed to list snapshot tools');
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
      const { error } = await u.rpc('activate_mcp_endpoint', { p_organization_id: orgId, p_endpoint_id: endpointId });
      if (error) throw new Error('failed to activate the MCP endpoint');
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
