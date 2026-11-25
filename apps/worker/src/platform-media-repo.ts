/**
 * @file platform-media-repo.ts
 * @description Read-only platform registry repository for the media executor.
 *
 * A worker-side port of the read subset of the web platform repository
 * (`apps/web/src/lib/platform/platform-repo.ts`): the executor only ever
 * READS the registry — binding, endpoint, approved snapshot — and re-reads
 * it on every job, so an operator revoking a snapshot or disabling a
 * binding takes effect on the next job without a restart. Registration,
 * approval and binding writes stay with the Control Center routes in web.
 *
 * Service-side only: constructed with the admin (service_role) client.
 * No organization exists anywhere in this module — platform rows have no
 * org column, and no method accepts an organization id. Ciphertext is never
 * read here (platform_connection_credentials is connect_broker-only even
 * for service_role); credentials resolve exclusively through the broker.
 */
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

export interface PlatformEndpointInfo {
  id: string;
  kind: string;
  url: string;
  displayName: string;
  status: string;
  connection: PlatformConnectionSummary | null;
}

export interface PlatformToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  permissionClass: PlatformPermissionClass;
}

/** An operator's capability -> (endpoint, remote tool) binding. */
export interface PlatformCapabilityBinding {
  capabilityKey: string;
  endpointId: string;
  toolName: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

type Row = Record<string, unknown>;
// The platform tables postdate the generated schema types; the admin client
// is used untyped inside this module and every row is mapped explicitly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminDb = { from(table: string): any };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface PlatformMediaRepository {
  getBinding(capabilityKey: string): Promise<PlatformCapabilityBinding | null>;
  getEndpoint(endpointId: string): Promise<PlatformEndpointInfo | null>;
  getApprovedTools(endpointId: string): Promise<{ snapshotId: string; tools: PlatformToolDef[] } | null>;
}

export function createPlatformMediaRepository(db: SupabaseClient): PlatformMediaRepository {
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

  return {
    async getBinding(capabilityKey) {
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

    async getEndpoint(endpointId) {
      const { data, error } = await t.from('platform_tool_endpoints')
        .select('id, kind, url, display_name, status, auth_connection_id')
        .eq('id', endpointId).maybeSingle();
      if (error) return fail(error, 'failed to read the platform endpoint');
      if (!data) return null;
      const r = data as Row;
      const connection = typeof r.auth_connection_id === 'string' ? await connectionById(r.auth_connection_id) : null;
      return {
        id: str(r.id), kind: str(r.kind), url: str(r.url), displayName: str(r.display_name),
        status: str(r.status), connection,
      };
    },

    /** The newest snapshot's tools, only when it is approved and unrevoked. */
    async getApprovedTools(endpointId) {
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
  };
}
