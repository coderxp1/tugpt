/**
 * @file workspace-maintenance.ts
 * @description Housekeeping for workspace file storage.
 *
 *   1. Blob deletion outbox (private.workspace_blob_deletions): delete blobs
 *      for removed files, or a whole organization prefix after a purge.
 *   2. Stale uploads: rows stuck in 'uploading' are removed (their blobs go
 *      through the outbox).
 *   3. Rate-limit counters older than two days are pruned.
 *   4. Organization purge (opt-in, TUGPT_ORG_PURGE_ENABLED=true): workspace
 *      data of organizations soft-deleted longer than the grace period.
 *   5. Orphan sweep (periodic): blobs with no workspace_files row and older
 *      than the grace period. Dry-run unless TUGPT_BLOB_SWEEP_DELETE=true,
 *      because a mis-pointed bucket would otherwise be emptied.
 *
 * Only ids and counts are logged; never object contents.
 */
import { blobKey, orgPrefix, parseBlobKey, type BlobStore } from '@tugpt/workspace-core';
import { callRpc, RpcError, type RpcClient } from './workspace-rpc.js';
import type { KnowledgeLog } from './knowledge-worker.js';

export interface MaintenanceDeps {
  readonly db: RpcClient;
  readonly store: BlobStore;
  readonly log: KnowledgeLog;
  readonly now?: () => Date;
}

export interface MaintenanceConfig {
  readonly staleUploadMinutes: number;
  readonly purgeEnabled: boolean;
  readonly purgeGraceDays: number;
  readonly sweepDelete: boolean;
  readonly sweepGraceHours: number;
}

export type MaintenanceEnv = Readonly<Record<string, string | undefined>>;

function intEnv(v: string | undefined, def: number, min: number, max: number): number {
  if (v === undefined || !/^\d{1,6}$/.test(v)) return def;
  return Math.min(Math.max(Number(v), min), max);
}

export function maintenanceConfig(env: MaintenanceEnv = process.env): MaintenanceConfig {
  return {
    staleUploadMinutes: intEnv(env.TUGPT_STALE_UPLOAD_MINUTES, 60, 15, 10080),
    purgeEnabled: env.TUGPT_ORG_PURGE_ENABLED === 'true',
    purgeGraceDays: intEnv(env.TUGPT_ORG_PURGE_GRACE_DAYS, 30, 7, 3650),
    sweepDelete: env.TUGPT_BLOB_SWEEP_DELETE === 'true',
    sweepGraceHours: intEnv(env.TUGPT_BLOB_SWEEP_GRACE_HOURS, 24, 1, 8760),
  };
}

interface BlobDeletion { readonly id: number; readonly organization_id: string; readonly file_id: string | null; readonly attempts: number }

export async function drainBlobDeletions(deps: MaintenanceDeps, limit = 100): Promise<{ done: number; failed: number }> {
  const rows = await callRpc<BlobDeletion[]>(deps.db, 'claim_blob_deletions', { p_limit: limit }) ?? [];
  const done: number[] = []; const failed: number[] = [];
  for (const r of rows) {
    try {
      if (r.file_id) {
        await deps.store.delete(blobKey(r.organization_id, r.file_id));
      } else {
        for await (const e of deps.store.list(orgPrefix(r.organization_id))) await deps.store.delete(e.key);
      }
      done.push(r.id);
    } catch {
      failed.push(r.id);
    }
  }
  if (rows.length) await callRpc(deps.db, 'complete_blob_deletions', { p_done: done, p_failed: failed });
  if (failed.length) deps.log.warn('workspace.blob_deletions_failed', { failed: failed.length });
  return { done: done.length, failed: failed.length };
}

export interface SweepResult { readonly scanned: number; readonly orphans: number; readonly deleted: number }

/** Finds blobs without a file row. Deletes them only when cfg.sweepDelete. */
export async function sweepOrphanBlobs(deps: MaintenanceDeps, cfg: Pick<MaintenanceConfig, 'sweepDelete' | 'sweepGraceHours'>): Promise<SweepResult> {
  const cutoff = (deps.now?.() ?? new Date()).getTime() - cfg.sweepGraceHours * 3600_000;
  let scanned = 0; let orphans = 0; let deleted = 0;
  let batch: { key: string; fileId: string }[] = [];
  const flush = async () => {
    if (!batch.length) return;
    const existing = new Set((await callRpc<string[]>(deps.db, 'workspace_files_existing', { p_file_ids: batch.map((b) => b.fileId) }) ?? []).map((x) => String(x).toLowerCase()));
    for (const b of batch) {
      if (existing.has(b.fileId)) continue;
      orphans += 1;
      if (cfg.sweepDelete) { await deps.store.delete(b.key); deleted += 1; }
    }
    batch = [];
  };
  for await (const e of deps.store.list('org/')) {
    scanned += 1;
    const parsed = parseBlobKey(e.key);
    if (!parsed || e.modifiedAt.getTime() > cutoff) continue; // too new: an upload may be in flight
    batch.push({ key: e.key, fileId: parsed.fileId });
    if (batch.length >= 500) await flush();
  }
  await flush();
  return { scanned, orphans, deleted };
}

export async function purgeDeletedOrganizations(deps: MaintenanceDeps, graceDays: number): Promise<number> {
  const orgs = await callRpc<{ organization_id: string }[]>(deps.db, 'list_purgeable_organizations', { p_grace_days: graceDays, p_limit: 20 }) ?? [];
  let purged = 0;
  for (const o of orgs) {
    try {
      const counts = await callRpc<Record<string, number>>(deps.db, 'purge_organization_workspace', { p_organization_id: o.organization_id, p_grace_days: graceDays });
      deps.log.info('workspace.organization_purged', { organizationId: o.organization_id, ...counts });
      purged += 1;
    } catch (e) {
      deps.log.error('workspace.organization_purge_failed', { organizationId: o.organization_id, code: e instanceof RpcError ? e.code : 'UNEXPECTED' });
    }
  }
  return purged;
}

export interface CycleReport {
  readonly expiredUploads: number; readonly prunedCounters: number; readonly purgedOrganizations: number;
  readonly blobsDeleted: number; readonly blobDeletionsFailed: number; readonly sweep?: SweepResult;
}

/** One maintenance pass. Each step is isolated so one failure does not skip the rest. */
export async function runMaintenanceCycle(deps: MaintenanceDeps, cfg: MaintenanceConfig, opts: { sweep: boolean }): Promise<CycleReport> {
  const step = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch (e) { deps.log.error('workspace.maintenance_step_failed', { step: name, code: e instanceof RpcError ? e.code : 'UNEXPECTED' }); return fallback; }
  };
  const expiredUploads = await step('expire_stale_uploads', () => callRpc<number>(deps.db, 'expire_stale_uploads', { p_older_than_minutes: cfg.staleUploadMinutes }), 0);
  const prunedCounters = await step('prune_rate_limits', () => callRpc<number>(deps.db, 'prune_workspace_rate_limits', {}), 0);
  const purgedOrganizations = cfg.purgeEnabled ? await step('purge_organizations', () => purgeDeletedOrganizations(deps, cfg.purgeGraceDays), 0) : 0;
  let blobsDeleted = 0; let blobDeletionsFailed = 0;
  for (let i = 0; i < 20; i += 1) { // bounded drain per cycle
    const r = await step('drain_blob_deletions', () => drainBlobDeletions(deps), { done: 0, failed: 0 });
    blobsDeleted += r.done; blobDeletionsFailed += r.failed;
    if (r.done + r.failed < 100) break;
  }
  const sweep = opts.sweep ? await step('sweep_orphans', () => sweepOrphanBlobs(deps, cfg), undefined) : undefined;
  const report: CycleReport = { expiredUploads, prunedCounters, purgedOrganizations, blobsDeleted, blobDeletionsFailed, ...(sweep ? { sweep } : {}) };
  deps.log.info('workspace.maintenance_cycle', { ...report, sweepDelete: cfg.sweepDelete, purgeEnabled: cfg.purgeEnabled });
  return report;
}
