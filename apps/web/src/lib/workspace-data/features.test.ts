/** Unit tests (no database) for the Q-14 feature signal. HTTP evidence: tests/workspace-e2e/contracts-q14-http.e2e.mjs. */
import { describe, expect, it } from 'vitest';
import type { DbResult } from './db';
import { FeatureProbeError, FEATURES_CONTRACT, MIGRATIONS, turnIdsSupported, workspaceFeatures, type ProbeDb } from './features';

/** errors[table] = PostgREST error code for that probe; absent = the relation/column exists. */
function probeDb(errors: Record<string, string> = {}) {
  const seen: string[] = [];
  const db: ProbeDb = {
    from(table) {
      return { select(columns) { return { limit(n) { seen.push(`${table}.${columns}:${n}`); const code = errors[table];
        return Promise.resolve({ data: code ? null : [], error: code ? { code, message: code } : null } as DbResult); } }; } };
    },
  };
  return { db, seen };
}

describe('workspaceFeatures (Q-14)', () => {
  it('fully migrated: every implemented feature is available; unimplemented ones say NOT_IMPLEMENTED', async () => {
    const { db, seen } = probeDb();
    const r = await workspaceFeatures(db);
    expect(r.contract).toBe(FEATURES_CONTRACT);
    expect(r.features).toEqual({
      'chat.turns': { state: 'available' },
      'chat.turnRunLease': { state: 'available' },
      'chat.regenerateCompleted': { state: 'unavailable', reason: 'NOT_IMPLEMENTED' },
      'files.uploadIdempotency': { state: 'available' },
      'library.writeRefusals': { state: 'available' },
      'library.atomicDocumentMove': { state: 'unavailable', reason: 'NOT_IMPLEMENTED' },
      'files.preview': { state: 'unavailable', reason: 'NOT_IMPLEMENTED' },
    });
    // Row-less probes only.
    expect(seen.sort()).toEqual(['chat_messages.turn_id:0', 'chat_turn_runs.expires_at:0', 'workspace_files.upload_request_id:0']);
  });
  it('pre-Q-13 database (no chat_turn_runs, no upload_request_id): those features are migration_pending with the migration names', async () => {
    const { features } = await workspaceFeatures(probeDb({ chat_turn_runs: 'PGRST205', workspace_files: 'PGRST204' }).db);
    expect(features['chat.turns']).toEqual({ state: 'available' });
    expect(features['chat.turnRunLease']).toEqual({ state: 'migration_pending', missingMigrations: [MIGRATIONS.turnRuns] });
    expect(features['files.uploadIdempotency']).toEqual({ state: 'migration_pending', missingMigrations: [MIGRATIONS.uploadRequestIds] });
  });
  it('pre-Q-12 database (no turn ids): chat.turns and the lease both report what is missing', async () => {
    const { features } = await workspaceFeatures(probeDb({ chat_messages: '42703', chat_turn_runs: '42P01', workspace_files: '42703' }).db);
    expect(features['chat.turns']).toEqual({ state: 'migration_pending', missingMigrations: [MIGRATIONS.turnIds] });
    expect(features['chat.turnRunLease']).toEqual({ state: 'migration_pending', missingMigrations: [MIGRATIONS.turnIds, MIGRATIONS.turnRuns] });
  });
  it('any other probe error fails the whole answer instead of guessing (permission denied, outage)', async () => {
    for (const code of ['42501', 'PGRST301', '08006']) {
      await expect(workspaceFeatures(probeDb({ chat_turn_runs: code }).db)).rejects.toBeInstanceOf(FeatureProbeError);
    }
  });
  it('turnIdsSupported: true / false on a missing column / throws otherwise', async () => {
    expect(await turnIdsSupported(probeDb().db)).toBe(true);
    expect(await turnIdsSupported(probeDb({ chat_messages: '42703' }).db)).toBe(false);
    await expect(turnIdsSupported(probeDb({ chat_messages: '42501' }).db)).rejects.toBeInstanceOf(FeatureProbeError);
  });
});
