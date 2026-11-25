/**
 * Platform registry repository (Plan B3, ADR-022 D1/D3).
 *
 * Service-side only: constructed with the admin (service_role) client, the
 * one identity besides connect_broker that can touch the platform tables.
 * No organization exists anywhere in this module — platform rows have no
 * org column, and no method accepts an organization id, so an org-scoped
 * caller cannot address platform data through it. Ciphertext is never read
 * here (platform_connection_credentials is connect_broker-only even for
 * service_role).
 */
import { createAdminSupabaseClient } from '@tugpt/database';
import type { SupabaseClient } from '@supabase/supabase-js';

export type PlatformPermissionClass = 'read' | 'write' | 'irreversible' | 'financial';
export const PLATFORM_PERMISSION_CLASSES: readonly PlatformPermissionClass[] = ['read', 'write', 'irreversible', 'financial'];

export class PlatformRepoError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PlatformRepoError';
  }
}

export interface PlatformConnectionSummary {
  id: string;
  providerKey: string;
  credentialKind: string;
  status: string;
}

export interface PlatformSnapshotSummary {
  id: string;
  version: number;
  approved: boolean;
  revoked: boolean;
  toolCount: number;
}

export interface PlatformEndpointRow {
  id: string;
  kind: string;
  url: string;
  displayName: string;
  status: string;
  createdAt: string;
  connection: PlatformConnectionSummary | null;
  latestSnapshot: PlatformSnapshotSummary | null;
}

export interface PlatformToolRow {
  name: string;
  description: string;
  permissionClass: PlatformPermissionClass;
}

export interface PlatformToolDef extends PlatformToolRow {
  inputSchema: Record<string, unknown>;
}

/** An operator's capability -> (endpoint, remote tool) binding (B6). */
export interface PlatformCapabilityBinding {
  capabilityKey: string;
  endpointId: string;
  toolName: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

export interface DiscoveredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type Row = Record<string, unknown>;
// The platform tables postdate the generated schema types; the admin client
// is used untyped inside this module and every row is mapped explicitly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = { from(table: string): any };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function createPlatformRepository(db: SupabaseClient) {
  const t = db as unknown as AdminDb;

  async function fail(error: { code?: string; message?: string } | null, what: string): Promise<never> {
    throw new PlatformRepoError(error?.code ?? 'INTERNAL', error?.message ?? what);
  }

  async function connectionById(id: string): Promise<PlatformConnectionSummary | null> {
    const { data, error } = await t.from('platform_connections').select('id, provider_key, credential_kind, status').eq('id', id).maybeSingle();
    if (error) return fail(error, 'failed to read the platform connection');
    if (!data) return null;
    const r = data as Row;
    return { id: str(r.id), providerKey: str(r.provider_key), credentialKind: str(r.credential_kind), status: str(r.status) };
  }

  async function latestSnapshot(endpointId: string): Promise<PlatformSnapshotSummary | null> {
    const { data, error } = await t.from('platform_tool_snapshots')
      .select('id, version, approved_at, revoked_at').eq('endpoint_id', endpointId)
      .order('version', { ascending: false }).limit(1).maybeSingle();
    if (error) return fail(error, 'failed to read the platform snapshot');
    if (!data) return null;
    const r = data as Row;
    const { count, error: countError } = await t.from('platform_tools')
      .select('id', { count: 'exact', head: true }).eq('snapshot_id', str(r.id));
    if (countError) return fail(countError, 'failed to count platform tools');
    return {
      id: str(r.id), version: Number(r.version),
      approved: r.approved_at != null, revoked: r.revoked_at != null,
      toolCount: typeof count === 'number' ? count : 0,
    };
  }

  async function endpointRow(r: Row): Promise<PlatformEndpointRow> {
    const connection = typeof r.auth_connection_id === 'string' ? await connectionById(r.auth_connection_id) : null;
    const snapshot = await latestSnapshot(str(r.id));
    return {
      id: str(r.id), kind: str(r.kind), url: str(r.url), displayName: str(r.display_name),
      status: str(r.status), createdAt: str(r.created_at), connection, latestSnapshot: snapshot,
    };
  }

  return {
    async listEndpoints(): Promise<PlatformEndpointRow[]> {
      const { data, error } = await t.from('platform_tool_endpoints')
        .select('id, kind, url, display_name, status, auth_connection_id, created_at')
        .order('created_at', { ascending: false });
      if (error) return fail(error, 'failed to list platform endpoints');
      const rows = (data ?? []) as Row[];
      return Promise.all(rows.map(endpointRow));
    },

    async getEndpoint(endpointId: string): Promise<PlatformEndpointRow | null> {
      const { data, error } = await t.from('platform_tool_endpoints')
        .select('id, kind, url, display_name, status, auth_connection_id, created_at')
        .eq('id', endpointId).maybeSingle();
      if (error) return fail(error, 'failed to read the platform endpoint');
      return data ? endpointRow(data as Row) : null;
    },

    /** Register a platform endpoint + its (pending) OAuth connection. */
    async registerEndpoint(input: { providerKey: string; url: string; displayName: string }): Promise<PlatformEndpointRow> {
      const { data: conn, error: connError } = await t.from('platform_connections')
        .insert({ provider_key: input.providerKey, credential_kind: 'oauth_token_set', status: 'requires_authorization' })
        .select('id').single();
      if (connError) return fail(connError, 'failed to create the platform connection');
      const connectionId = str((conn as Row).id);
      const { data, error } = await t.from('platform_tool_endpoints')
        .insert({ kind: 'mcp', url: input.url, display_name: input.displayName, status: 'pending', auth_connection_id: connectionId })
        .select('id, kind, url, display_name, status, auth_connection_id, created_at').single();
      if (error) {
        await t.from('platform_connections').delete().eq('id', connectionId);
        return fail(error, 'failed to register the platform endpoint');
      }
      return endpointRow(data as Row);
    },

    /** Store a discovery result as the next snapshot version (unapproved). */
    async createSnapshot(endpointId: string, tools: readonly DiscoveredTool[], contentSha256: string): Promise<PlatformSnapshotSummary> {
      const latest = await latestSnapshot(endpointId);
      const version = (latest?.version ?? 0) + 1;
      const { data, error } = await t.from('platform_tool_snapshots')
        .insert({ endpoint_id: endpointId, version, content_sha256: contentSha256 })
        .select('id, version, approved_at, revoked_at').single();
      if (error) return fail(error, 'failed to store the platform snapshot');
      const snapshot = data as Row;
      const rows = tools.map((tool) => ({
        snapshot_id: str(snapshot.id), name: tool.name, description: tool.description, input_schema: tool.inputSchema,
      }));
      if (rows.length > 0) {
        const { error: toolsError } = await t.from('platform_tools').insert(rows);
        if (toolsError) {
          await t.from('platform_tool_snapshots').delete().eq('id', str(snapshot.id));
          return fail(toolsError, 'failed to store the platform tools');
        }
      }
      return { id: str(snapshot.id), version, approved: false, revoked: false, toolCount: rows.length };
    },

    /** The newest snapshot's tools, only when it is approved and unrevoked. */
    async getApprovedTools(endpointId: string): Promise<{ snapshotId: string; tools: PlatformToolDef[] } | null> {
      const { data, error } = await t.from('platform_tool_snapshots')
        .select('id, approved_at, revoked_at').eq('endpoint_id', endpointId)
        .order('version', { ascending: false }).limit(1).maybeSingle();
      if (error) return fail(error, 'failed to read the platform snapshot');
      if (!data) return null;
      const s = data as Row;
      if (s.approved_at == null || s.revoked_at != null) return null;
      const { data: toolRows, error: toolsError } = await t.from('platform_tools')
        .select('name, description, input_schema, permission_class').eq('snapshot_id', str(s.id)).order('name', { ascending: true });
      if (toolsError) return fail(toolsError, 'failed to list platform tools');
      return {
        snapshotId: str(s.id),
        tools: ((toolRows ?? []) as Row[]).map((r) => ({
          name: str(r.name), description: str(r.description),
          inputSchema: (typeof r.input_schema === 'object' && r.input_schema !== null ? r.input_schema : {}) as Record<string, unknown>,
          permissionClass: (PLATFORM_PERMISSION_CLASSES as readonly string[]).includes(str(r.permission_class))
            ? (str(r.permission_class) as PlatformPermissionClass) : 'write',
        })),
      };
    },

    async getBinding(capabilityKey: string): Promise<PlatformCapabilityBinding | null> {
      const { data, error } = await t.from('platform_capability_bindings')
        .select('capability_key, endpoint_id, tool_name, config, enabled').eq('capability_key', capabilityKey).maybeSingle();
      if (error) return fail(error, 'failed to read the capability binding');
      if (!data) return null;
      const r = data as Row;
      return {
        capabilityKey: str(r.capability_key), endpointId: str(r.endpoint_id), toolName: str(r.tool_name),
        config: (typeof r.config === 'object' && r.config !== null ? r.config : {}) as Record<string, unknown>,
        enabled: r.enabled === true,
      };
    },

    async upsertBinding(binding: PlatformCapabilityBinding): Promise<void> {
      const { error } = await t.from('platform_capability_bindings').upsert({
        capability_key: binding.capabilityKey, endpoint_id: binding.endpointId, tool_name: binding.toolName,
        config: binding.config, enabled: binding.enabled, updated_at: new Date().toISOString(),
      }, { onConflict: 'capability_key' });
      if (error) return fail(error, 'failed to store the capability binding');
    },

    async listSnapshotTools(snapshotId: string): Promise<PlatformToolRow[]> {
      const { data, error } = await t.from('platform_tools')
        .select('name, description, permission_class').eq('snapshot_id', snapshotId).order('name', { ascending: true });
      if (error) return fail(error, 'failed to list platform tools');
      return ((data ?? []) as Row[]).map((r) => ({
        name: str(r.name), description: str(r.description),
        permissionClass: (PLATFORM_PERMISSION_CLASSES as readonly string[]).includes(str(r.permission_class))
          ? (str(r.permission_class) as PlatformPermissionClass) : 'write',
      }));
    },

    /**
     * Classify the snapshot's tools, then approve it. Classification writes
     * happen BEFORE the approval timestamp is set — the database trigger
     * freezes tool rows under an approved snapshot.
     */
    async approveSnapshot(snapshotId: string, classes: readonly { name: string; permissionClass: PlatformPermissionClass }[]): Promise<void> {
      const { data: snap, error } = await t.from('platform_tool_snapshots')
        .select('id, approved_at, revoked_at').eq('id', snapshotId).maybeSingle();
      if (error) return fail(error, 'failed to read the platform snapshot');
      if (!snap) throw new PlatformRepoError('P0002', 'platform snapshot not found');
      const s = snap as Row;
      if (s.approved_at != null) throw new PlatformRepoError('PT409', 'the snapshot is already approved');
      if (s.revoked_at != null) throw new PlatformRepoError('PT409', 'the snapshot is revoked');
      const tools = await this.listSnapshotTools(snapshotId);
      const known = new Set(tools.map((tool) => tool.name));
      for (const c of classes) {
        if (!known.has(c.name)) throw new PlatformRepoError('UNKNOWN_TOOL', `unknown tool: ${c.name}`);
      }
      for (const c of classes) {
        const { error: updError } = await t.from('platform_tools')
          .update({ permission_class: c.permissionClass }).eq('snapshot_id', snapshotId).eq('name', c.name);
        if (updError) return fail(updError, 'failed to classify a platform tool');
      }
      const { error: approveError } = await t.from('platform_tool_snapshots')
        .update({ approved_at: new Date().toISOString() }).eq('id', snapshotId);
      if (approveError) return fail(approveError, 'failed to approve the platform snapshot');
    },

    /** Activation requires the newest snapshot approved and unrevoked. */
    async setEndpointStatus(endpointId: string, status: 'active' | 'disabled'): Promise<string> {
      const endpoint = await this.getEndpoint(endpointId);
      if (!endpoint) throw new PlatformRepoError('P0002', 'platform endpoint not found');
      if (status === 'active') {
        const latest = endpoint.latestSnapshot;
        if (!latest || !latest.approved || latest.revoked) {
          throw new PlatformRepoError('SNAPSHOT_NOT_APPROVED', 'the newest platform snapshot must be approved and not revoked before activation');
        }
      }
      const { error } = await t.from('platform_tool_endpoints').update({ status }).eq('id', endpointId);
      if (error) return fail(error, 'failed to update the platform endpoint');
      return status;
    },

    async deleteEndpoint(endpointId: string): Promise<boolean> {
      const endpoint = await this.getEndpoint(endpointId);
      if (!endpoint) return false;
      const { error } = await t.from('platform_tool_endpoints').delete().eq('id', endpointId);
      if (error) return fail(error, 'failed to delete the platform endpoint');
      if (endpoint.connection) {
        const { data: refs } = await t.from('platform_tool_endpoints')
          .select('id').eq('auth_connection_id', endpoint.connection.id).limit(1);
        if (!refs || (refs as unknown[]).length === 0) {
          await t.from('platform_connections').delete().eq('id', endpoint.connection.id);
        }
      }
      return true;
    },
  };
}

export type PlatformRepository = ReturnType<typeof createPlatformRepository>;

/** The repository over the process admin client (service_role). */
export function platformRepository(): PlatformRepository {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new PlatformRepoError('NOT_CONFIGURED', 'platform storage is not configured');
  // Untyped client: the platform tables postdate the generated schema types.
  return createPlatformRepository(createAdminSupabaseClient(url, key) as unknown as SupabaseClient);
}
