/**
 * Reads the real gates for the active organization. Server only; the result is
 * plain data (no secrets, no URLs, no flag names) and is safe to render.
 *
 * Every fact comes from one source, and any failure reads as "could not check":
 *   drafts/inbox/knowledge  is_feature_enabled('ai_draft_generation') (organization flag)
 *   google/microsoft/mcp    list_chat_capabilities under the caller's RLS
 *   workspace/library/approvals  row-less probes (limit 0) of the tables they need
 *   chat model, images, MCP management, MCP in chat, custom agents  deployment config
 */
import { cache } from 'react';
import { getSessionContext } from '@/lib/tenant/server';
import { createAuthenticatedServerClient, createFeatureServerClient } from '@/lib/supabase/server';
import { checkDraftFeatureGate } from '@/lib/draft-api/feature-gate';
import { asChatDb, listCapabilities, type CapabilityRow } from '@/lib/chat/store';
import { customerMcpEnabled } from '@/lib/connect-ui/flags.server';
import { canManageConnections } from '@/lib/connect-ui/contract';
import { CHAT_MCP_EXECUTION_ENV } from '@/lib/chat/mcp';
import { configuredImageService } from '@/lib/create/image-service';
import { configuredModels } from '@/lib/chat/models';
import { agentsApiAvailable } from '@/lib/workspace/agents';
import { isMissingColumn, isMissingTable } from '@/lib/supabase/schema-compat';
import type { ProbeDb } from '@/lib/workspace-data/features';
import { createTranslator } from '@/i18n';
import { getRequestLocale } from '@/i18n/server';
import { describeFeatures, type FeatureStatus, type ProviderGate, type SchemaGate } from './features';

export function providerGate(rows: readonly CapabilityRow[] | null, key: string): ProviderGate {
  if (rows === null) return 'unknown';
  const mine = rows.filter((r) => r.providerKey === key);
  if (mine.some((r) => r.state === 'connected')) return 'connected';
  if (mine.some((r) => r.state === 'requires_connection')) return 'ready';
  return 'off';
}

/** At least one approved, active customer MCP tool; null when the rows could not be read. */
export function mcpActive(rows: readonly CapabilityRow[] | null): boolean | null {
  if (rows === null) return null;
  return rows.some((r) => r.providerKey === 'mcp' && r.state === 'connected');
}

/** Classifies one row-less probe: ok, the table is absent from this database, or anything else (unknown). */
export function schemaGate(error: { code?: string } | null | undefined): SchemaGate {
  if (!error) return 'ok';
  return isMissingTable(error) || isMissingColumn(error) ? 'missing' : 'unknown';
}

export async function probeTable(db: ProbeDb, table: string, column = 'id'): Promise<SchemaGate> {
  try { return schemaGate((await db.from(table).select(column).limit(0)).error); } catch { return 'unknown'; }
}

export const loadOrgFeatures = cache(async (): Promise<FeatureStatus[]> => {
  const session = await getSessionContext();
  const orgId = session?.tenant?.organizationId ?? null;
  let draftsEnabled: boolean | null = null;
  let rows: CapabilityRow[] | null = null;
  let workspaceDb: SchemaGate = 'unknown', libraryDb: SchemaGate = 'unknown', approvalsDb: SchemaGate = 'unknown';
  if (orgId) {
    try { draftsEnabled = (await checkDraftFeatureGate(await createFeatureServerClient(orgId), orgId)).allowed; } catch { draftsEnabled = null; }
    try {
      const db = await createAuthenticatedServerClient();
      const probe = db as unknown as ProbeDb;
      [rows, workspaceDb, libraryDb, approvalsDb] = await Promise.all([
        listCapabilities(asChatDb(db), orgId).catch(() => null),
        probeTable(probe, 'chat_threads'),
        probeTable(probe, 'knowledge_collections'),
        probeTable(probe, 'approval_requests'),
      ]);
    } catch { rows = null; }
  }
  let imagesConfigured = false;
  try { imagesConfigured = configuredImageService() !== null; } catch { imagesConfigured = false; }
  let hasChatModel = false;
  try { hasChatModel = configuredModels().length > 0; } catch { hasChatModel = false; }
  return describeFeatures({
    draftsEnabled,
    google: providerGate(rows, 'google'),
    microsoft: providerGate(rows, 'microsoft'),
    mcpManage: customerMcpEnabled(),
    mcpActive: mcpActive(rows),
    mcpChat: process.env[CHAT_MCP_EXECUTION_ENV]?.trim() === 'true',
    imagesConfigured,
    hasChatModel,
    workspaceDb, libraryDb, approvalsDb,
    customAgents: agentsApiAvailable,
    canManage: canManageConnections(session?.tenant?.role),
  }, createTranslator(await getRequestLocale()));
});
