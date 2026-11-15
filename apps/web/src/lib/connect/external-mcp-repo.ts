/**
 * Typed access to the customer-MCP tables.
 *
 * `external_tool_endpoints`/`snapshots`/`tools` are not yet in the generated
 * Supabase types (the Connect migration hasn't been applied to the
 * types-generating DB). Rather than scatter `as any` across the routes, this
 * module is the single place that casts the admin client, and it exposes
 * typed methods with explicit organization scoping. When the generated types
 * catch up, only this file changes.
 */

import type { TypedSupabaseClient } from '@tugpt/database';

export type PermissionClass = 'read' | 'write' | 'irreversible' | 'financial';

export interface ExternalToolEndpoint {
  readonly id: string;
  readonly url: string;
  readonly displayName: string;
  readonly status: 'pending' | 'active' | 'disabled';
}

export interface ExternalToolSnapshot {
  readonly id: string;
  readonly approvedAt: string | null;
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

export interface ExternalMcpRepository {
  createEndpoint(orgId: string, userId: string, url: string, displayName: string): Promise<ExternalToolEndpoint>;
  getEndpoint(orgId: string, endpointId: string): Promise<{ id: string; url: string; status: string } | null>;
  listEndpoints(orgId: string): Promise<ExternalToolEndpoint[]>;
  createSnapshot(orgId: string, endpointId: string, version: number, contentSha256: string): Promise<string>;
  createTools(orgId: string, snapshotId: string, tools: readonly ExternalToolListEntry[]): Promise<void>;
  getSnapshot(orgId: string, snapshotId: string): Promise<ExternalToolSnapshot | null>;
  listSnapshotTools(orgId: string, snapshotId: string): Promise<ExternalToolWithPermission[]>;
  setToolPermission(orgId: string, snapshotId: string, name: string, permissionClass: PermissionClass): Promise<void>;
  approveSnapshot(orgId: string, snapshotId: string, userId: string): Promise<void>;
  hasApprovedSnapshot(orgId: string, endpointId: string): Promise<boolean>;
  activateEndpoint(orgId: string, endpointId: string): Promise<void>;
  deactivateEndpoint(orgId: string, endpointId: string): Promise<void>;
  deleteEndpoint(orgId: string, endpointId: string): Promise<void>;
}

// The one cast for these not-yet-generated tables.
type Untyped = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- single cast for not-yet-generated tables
  from(table: string): any;
};

export function createExternalMcpRepository(db: TypedSupabaseClient): ExternalMcpRepository {
  const u = db as unknown as Untyped;

  return {
    async createEndpoint(orgId, userId, url, displayName) {
      const { data, error } = await u
        .from('external_tool_endpoints')
        .insert({ organization_id: orgId, kind: 'mcp', url, display_name: displayName, status: 'pending', created_by: userId })
        .select('id, url, display_name, status')
        .single();
      if (error || !data) throw new Error('failed to create the MCP endpoint');
      return { id: data.id, url: data.url, displayName: data.display_name, status: data.status };
    },

    async getEndpoint(orgId, endpointId) {
      const { data, error } = await u
        .from('external_tool_endpoints')
        .select('id, url, status')
        .eq('id', endpointId)
        .eq('organization_id', orgId)
        .maybeSingle();
      if (error || !data) return null;
      return { id: data.id, url: data.url, status: data.status };
    },

    async listEndpoints(orgId) {
      const { data, error } = await u
        .from('external_tool_endpoints')
        .select('id, url, display_name, status')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false });
      if (error) throw new Error('failed to list MCP endpoints');
      const rows = Array.isArray(data) ? data : [];
      return rows.map((d) => ({ id: d.id, url: d.url, displayName: d.display_name, status: d.status }));
    },

    async createSnapshot(orgId, endpointId, version, contentSha256) {
      const { data, error } = await u
        .from('external_tool_snapshots')
        .insert({ organization_id: orgId, endpoint_id: endpointId, version, content_sha256: contentSha256 })
        .select('id')
        .single();
      if (error || !data) throw new Error('failed to persist the tool snapshot');
      return data.id as string;
    },

    async createTools(orgId, snapshotId, tools) {
      const { error } = await u.from('external_tools').insert(
        tools.map((t) => ({
          organization_id: orgId,
          snapshot_id: snapshotId,
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
          permission_class: 'write',
        })),
      );
      if (error) throw new Error('failed to persist the tools');
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
      return rows.map((d) => ({
        name: d.name,
        description: d.description,
        inputSchema: d.input_schema,
        permissionClass: d.permission_class,
      }));
    },

    async setToolPermission(orgId, snapshotId, name, permissionClass) {
      const { error } = await u
        .from('external_tools')
        .update({ permission_class: permissionClass })
        .eq('organization_id', orgId)
        .eq('snapshot_id', snapshotId)
        .eq('name', name);
      if (error) throw new Error(`failed to set permission for "${name}"`);
    },

    async approveSnapshot(orgId, snapshotId, userId) {
      const { error } = await u
        .from('external_tool_snapshots')
        .update({ approved_by: userId, approved_at: new Date().toISOString() })
        .eq('id', snapshotId)
        .eq('organization_id', orgId);
      if (error) throw new Error('failed to approve the MCP snapshot');
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

    async activateEndpoint(orgId, endpointId) {
      const { error } = await u
        .from('external_tool_endpoints')
        .update({ status: 'active' })
        .eq('id', endpointId)
        .eq('organization_id', orgId);
      if (error) throw new Error('failed to activate the MCP endpoint');
    },

    async deactivateEndpoint(orgId, endpointId) {
      const { error } = await u
        .from('external_tool_endpoints')
        .update({ status: 'disabled' })
        .eq('id', endpointId)
        .eq('organization_id', orgId);
      if (error) throw new Error('failed to deactivate the MCP endpoint');
    },

    async deleteEndpoint(orgId, endpointId) {
      const { error } = await u
        .from('external_tool_endpoints')
        .delete()
        .eq('id', endpointId)
        .eq('organization_id', orgId);
      if (error) throw new Error('failed to delete the MCP endpoint');
    },
  };
}
