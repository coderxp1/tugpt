/**
 * Runtime feature signal for the Workspace frontend (Q-14, request 1).
 *
 * GET /api/v1/chat/features answers, for THIS deployment and THIS
 * caller's database session, which backend contracts the frontend may use:
 *
 *   available          the code is deployed AND the database has the migration it needs
 *   migration_pending  the code is deployed but the database lacks the migration (expand
 *                      window); the backend then behaves as the previous release did
 *   unavailable        not implemented in this build (reason: NOT_IMPLEMENTED)
 *
 * Probes run under the caller's own RLS session with `limit(0)` (no rows are read) and
 * classify ONLY "relation/column does not exist" as migration_pending (the same codes the
 * expand/contract fallbacks use, lib/supabase/schema-compat.ts). Any other error fails the
 * whole request (503) instead of guessing; the client then keeps its legacy behaviour.
 *
 * Client rule: use a contract only when its feature is `available`. A missing feature key,
 * a 404 for this endpoint (pre-Q-14 deployment) or a 503 all mean "unknown": do not use it.
 * Worker-side features (document formats) are deliberately not reported: the web app cannot
 * see which worker build is running.
 */
import type { DbResult } from './db';
import { isMissingColumn, isMissingTable } from '@/lib/supabase/schema-compat';

export const FEATURES_CONTRACT = 'workspace-features/1';

export type FeatureState = 'available' | 'migration_pending' | 'unavailable';
export interface FeatureStatus {
  readonly state: FeatureState;
  /** Set when state is migration_pending: the migration file(s) this database still needs. */
  readonly missingMigrations?: readonly string[];
  /** Set when state is unavailable. */
  readonly reason?: 'NOT_IMPLEMENTED';
}

export const MIGRATIONS = {
  turnIds: '20261121100001_workspace_chat_turns',
  turnRuns: '20261122100001_workspace_chat_turn_runs',
  uploadRequestIds: '20261122100002_workspace_file_upload_request_ids',
} as const;
type Probe = keyof typeof MIGRATIONS;

/** Read-only probes: one cheap, row-less select each, under the caller's RLS. */
const PROBES: Record<Probe, { table: string; column: string; missing: (e: { code?: string }) => boolean }> = {
  turnIds: { table: 'chat_messages', column: 'turn_id', missing: isMissingColumn },
  turnRuns: { table: 'chat_turn_runs', column: 'expires_at', missing: (e) => isMissingTable(e) || isMissingColumn(e) },
  uploadRequestIds: { table: 'workspace_files', column: 'upload_request_id', missing: isMissingColumn },
};

export interface ProbeDb {
  from(table: string): { select(columns: string): { limit(n: number): PromiseLike<DbResult> } };
}

export class FeatureProbeError extends Error {
  constructor(readonly probe: string, readonly code: string | undefined) { super(`feature probe ${probe} failed`); this.name = 'FeatureProbeError'; }
}

/** true = the migration is present; false = PostgREST reports the relation/column as unknown. */
export async function probeSchema(db: ProbeDb): Promise<Record<Probe, boolean>> {
  const keys = Object.keys(PROBES) as Probe[];
  const results = await Promise.all(keys.map(async (k) => {
    const p = PROBES[k];
    const r = await db.from(p.table).select(p.column).limit(0);
    if (!r.error) return true;
    if (p.missing(r.error)) return false;
    throw new FeatureProbeError(k, r.error.code);
  }));
  return Object.fromEntries(keys.map((k, i) => [k, results[i]])) as Record<Probe, boolean>;
}

const needs = (present: Record<Probe, boolean>, ...probes: Probe[]): FeatureStatus => {
  const missing = probes.filter((p) => !present[p]).map((p) => MIGRATIONS[p]);
  return missing.length ? { state: 'migration_pending', missingMigrations: missing } : { state: 'available' };
};
const notImplemented: FeatureStatus = { state: 'unavailable', reason: 'NOT_IMPLEMENTED' };

/**
 * Feature keys are stable; new keys may be added, existing ones are never repurposed.
 *   chat.turns                 turnId on send, GET .../turns/{turnId}, retry:true of the latest
 *                              error|stopped|interrupted turn, 409 TURN_* codes, 404 TURN_NOT_FOUND
 *   chat.turnRunLease          one model run per turn: a running (re)try is `pending`, a concurrent
 *                              retry gets 409 TURN_IN_PROGRESS, crash recovery after the 150 s lease
 *   chat.regenerateCompleted   re-answering a COMPLETE turn (not implemented: 409 TURN_EXISTS)
 *   files.uploadIdempotency    Idempotency-Key on POST /files (replay / 409 codes)
 *   library.writeRefusals      remove/rename/delete answer 403 FORBIDDEN when the caller can read
 *                              but not change; 404 only when absent (so 404 on remove = already removed)
 *   library.atomicDocumentMove a single move call (not implemented: add to destination, then remove)
 *   files.preview              inline preview of PDF/Office files (not implemented: download only)
 */
export function featureTable(present: Record<Probe, boolean>): Record<string, FeatureStatus> {
  return {
    'chat.turns': needs(present, 'turnIds'),
    'chat.turnRunLease': needs(present, 'turnIds', 'turnRuns'),
    'chat.regenerateCompleted': notImplemented,
    'files.uploadIdempotency': needs(present, 'uploadRequestIds'),
    'library.writeRefusals': { state: 'available' },
    'library.atomicDocumentMove': notImplemented,
    'files.preview': notImplemented,
  };
}

export async function workspaceFeatures(db: ProbeDb): Promise<{ contract: string; features: Record<string, FeatureStatus> }> {
  return { contract: FEATURES_CONTRACT, features: featureTable(await probeSchema(db)) };
}

/** Used by GET .../turns/{turnId} to tell "never stored" from "this database has no turn ids". */
export async function turnIdsSupported(db: ProbeDb): Promise<boolean> {
  const r = await db.from(PROBES.turnIds.table).select(PROBES.turnIds.column).limit(0);
  if (!r.error) return true;
  if (isMissingColumn(r.error)) return false;
  throw new FeatureProbeError('turnIds', r.error.code);
}
