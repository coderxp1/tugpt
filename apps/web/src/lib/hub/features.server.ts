/**
 * Reads the real gates for the active organization. Server only; the result is
 * plain data (no secrets, no URLs, no flag names) and is safe to render.
 */
import { cache } from 'react';
import { getSessionContext } from '@/lib/tenant/server';
import { createAuthenticatedServerClient, createFeatureServerClient } from '@/lib/supabase/server';
import { checkDraftFeatureGate } from '@/lib/draft-api/feature-gate';
import { asChatDb, listCapabilities, type CapabilityRow } from '@/lib/chat/store';
import { customerMcpEnabled } from '@/lib/connect-ui/flags.server';
import { CHAT_MCP_EXECUTION_ENV } from '@/lib/chat/mcp';
import { configuredImageService } from '@/lib/create/image-service';
import { configuredModels } from '@/lib/chat/models';
import { createTranslator } from '@/i18n';
import { getRequestLocale } from '@/i18n/server';
import { describeFeatures, type FeatureStatus, type ProviderGate } from './features';

export function providerGate(rows: readonly CapabilityRow[] | null, key: string): ProviderGate {
  if (rows === null) return 'unknown';
  const mine = rows.filter((r) => r.providerKey === key);
  if (mine.some((r) => r.state === 'connected')) return 'connected';
  if (mine.some((r) => r.state === 'requires_connection')) return 'ready';
  return 'off';
}

export const loadOrgFeatures = cache(async (): Promise<FeatureStatus[]> => {
  const session = await getSessionContext();
  const orgId = session?.tenant?.organizationId ?? null;
  let draftsEnabled: boolean | null = null;
  let rows: CapabilityRow[] | null = null;
  if (orgId) {
    try { draftsEnabled = (await checkDraftFeatureGate(await createFeatureServerClient(orgId), orgId)).allowed; } catch { draftsEnabled = null; }
    try { rows = await listCapabilities(asChatDb(await createAuthenticatedServerClient()), orgId); } catch { rows = null; }
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
    mcpChat: process.env[CHAT_MCP_EXECUTION_ENV]?.trim() === 'true',
    imagesConfigured,
    hasChatModel,
  }, createTranslator(await getRequestLocale()));
});
