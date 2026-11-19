/**
 * @file workspace-maintenance-index.ts
 * @description Entry point for workspace storage maintenance (see
 * workspace-maintenance.ts). Runs a cycle every WORKSPACE_MAINTENANCE_INTERVAL_MS
 * (default 15 min) and the orphan sweep every TUGPT_BLOB_SWEEP_INTERVAL_HOURS
 * (default 6 h). Destructive options are opt-in:
 *   TUGPT_ORG_PURGE_ENABLED=true   purge workspace data of soft-deleted orgs
 *   TUGPT_BLOB_SWEEP_DELETE=true   delete orphan blobs (otherwise only counted)
 */
import { createAdminSupabaseClient } from '@tugpt/database';
import { Logger } from '@tugpt/observability';
import { configuredBlobStore } from '@tugpt/workspace-core';
import { maintenanceConfig, runMaintenanceCycle } from './workspace-maintenance.js';
import type { RpcClient } from './workspace-rpc.js';
import { knowledgeLogFrom } from './knowledge-worker.js';

async function main(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const store = configuredBlobStore();
  if (!supabaseUrl || !serviceRoleKey || !store) {
    console.error(JSON.stringify({ error: 'Missing required environment variables', required: ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TUGPT_FILE_STORAGE (+ settings)'] }));
    process.exit(1);
  }
  const log = knowledgeLogFrom(new Logger({ service: 'workspace-maintenance' }));
  const db = createAdminSupabaseClient(supabaseUrl, serviceRoleKey) as unknown as RpcClient;
  const cfg = maintenanceConfig();
  const intervalMs = Math.max(60_000, Number.parseInt(process.env.WORKSPACE_MAINTENANCE_INTERVAL_MS || '900000', 10) || 900_000);
  const sweepEveryMs = Math.max(1, Number.parseInt(process.env.TUGPT_BLOB_SWEEP_INTERVAL_HOURS || '6', 10) || 6) * 3600_000;
  log.info('workspace.maintenance_started', { storage: store.kind, ...cfg });

  const abort = new AbortController();
  process.on('SIGINT', () => abort.abort());
  process.on('SIGTERM', () => abort.abort());
  let lastSweep = 0;
  while (!abort.signal.aborted) {
    const sweep = Date.now() - lastSweep >= sweepEveryMs;
    await runMaintenanceCycle({ db, store, log }, cfg, { sweep });
    if (sweep) lastSweep = Date.now();
    await new Promise<void>((r) => { const t = setTimeout(r, intervalMs); abort.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: 'Workspace maintenance fatal error', message: (err as Error).message }));
  process.exit(1);
});
