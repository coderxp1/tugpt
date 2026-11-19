import { describe, expect, it } from 'vitest';
import { blobKey, MemoryBlobStore } from '@tugpt/workspace-core';
import { drainBlobDeletions, maintenanceConfig, runMaintenanceCycle, sweepOrphanBlobs } from '../src/workspace-maintenance';
import type { KnowledgeLog } from '../src/knowledge-worker';
import type { RpcClient, RpcResult } from '../src/workspace-rpc';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const F1 = '11111111-1111-4111-8111-111111111111';
const F2 = '22222222-2222-4222-8222-222222222222';
const F3 = '33333333-3333-4333-8333-333333333333';
const log: KnowledgeLog = { info: () => {}, warn: () => {}, error: () => {} };
const bytes = new Uint8Array([1, 2, 3]);

function db(handlers: Record<string, (a: Record<string, unknown>) => unknown>): RpcClient & { calls: { fn: string; args: Record<string, unknown> }[] } {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return { calls, rpc: (fn, args = {}) => { calls.push({ fn, args }); return Promise.resolve({ data: handlers[fn]?.(args) ?? null, error: null } as RpcResult); } };
}

describe('workspace maintenance', () => {
  it('config defaults are safe: purge and orphan deletion are off', () => {
    expect(maintenanceConfig({})).toEqual({ staleUploadMinutes: 60, purgeEnabled: false, purgeGraceDays: 30, sweepDelete: false, sweepGraceHours: 24 });
    expect(maintenanceConfig({ TUGPT_ORG_PURGE_GRACE_DAYS: '1', TUGPT_STALE_UPLOAD_MINUTES: '1' })).toMatchObject({ purgeGraceDays: 7, staleUploadMinutes: 15 });
    expect(maintenanceConfig({ TUGPT_ORG_PURGE_ENABLED: 'yes' }).purgeEnabled).toBe(false);
  });

  it('drains file and organization-prefix deletions and reports results', async () => {
    const store = new MemoryBlobStore();
    await store.put(blobKey(A, F1), bytes, 'text/plain');
    await store.put(blobKey(B, F2), bytes, 'text/plain');
    await store.put(blobKey(B, F3), bytes, 'text/plain');
    const d = db({ claim_blob_deletions: () => [{ id: 1, organization_id: A, file_id: F1, attempts: 1 }, { id: 2, organization_id: B, file_id: null, attempts: 1 }] });
    expect(await drainBlobDeletions({ db: d, store, log })).toEqual({ done: 2, failed: 0 });
    expect(store.objects.size).toBe(0);
    expect(d.calls.at(-1)).toEqual({ fn: 'complete_blob_deletions', args: { p_done: [1, 2], p_failed: [] } });
  });

  it('reports failed blob deletions for retry', async () => {
    const store = new MemoryBlobStore(); store.delete = async () => { throw new Error('denied'); };
    const d = db({ claim_blob_deletions: () => [{ id: 7, organization_id: A, file_id: F1, attempts: 1 }] });
    expect(await drainBlobDeletions({ db: d, store, log })).toEqual({ done: 0, failed: 1 });
    expect(d.calls.at(-1)?.args).toEqual({ p_done: [], p_failed: [7] });
  });

  it('orphan sweep is dry-run by default, honours the grace period and deletes only when enabled', async () => {
    const now = new Date('2027-01-10T00:00:00Z');
    const store = new MemoryBlobStore();
    for (const f of [F1, F2, F3]) await store.put(blobKey(A, f), bytes, 'text/plain');
    store.modified.set(blobKey(A, F1), new Date('2027-01-01T00:00:00Z')); // old, row exists
    store.modified.set(blobKey(A, F2), new Date('2027-01-01T00:00:00Z')); // old, orphan
    store.modified.set(blobKey(A, F3), new Date('2027-01-09T23:00:00Z')); // orphan but too new
    const d = db({ workspace_files_existing: () => [F1] });
    expect(await sweepOrphanBlobs({ db: d, store, log, now: () => now }, { sweepDelete: false, sweepGraceHours: 24 })).toEqual({ scanned: 3, orphans: 1, deleted: 0 });
    expect(store.objects.size).toBe(3);
    expect(d.calls[0].args.p_file_ids).toEqual([F1, F2]);
    expect(await sweepOrphanBlobs({ db: d, store, log, now: () => now }, { sweepDelete: true, sweepGraceHours: 24 })).toEqual({ scanned: 3, orphans: 1, deleted: 1 });
    expect([...store.objects.keys()].sort()).toEqual([blobKey(A, F1), blobKey(A, F3)].sort());
  });

  it('a cycle runs every step, skips purge unless enabled, and survives a failing step', async () => {
    const store = new MemoryBlobStore();
    const calls: string[] = [];
    const d: RpcClient = { rpc: (fn) => { calls.push(fn); if (fn === 'prune_workspace_rate_limits') return Promise.resolve({ data: null, error: { message: 'DB_DOWN' } }); return Promise.resolve({ data: fn === 'claim_blob_deletions' ? [] : 0, error: null }); } };
    const cfg = maintenanceConfig({});
    const r = await runMaintenanceCycle({ db: d, store, log }, cfg, { sweep: false });
    expect(calls).toEqual(['expire_stale_uploads', 'prune_workspace_rate_limits', 'claim_blob_deletions']);
    expect(r.purgedOrganizations).toBe(0);
    calls.length = 0;
    await runMaintenanceCycle({ db: d, store, log }, { ...cfg, purgeEnabled: true }, { sweep: false });
    expect(calls).toContain('list_purgeable_organizations');
  });
});
