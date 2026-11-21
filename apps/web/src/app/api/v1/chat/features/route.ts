/**
 * GET /api/v1/chat/features: which Workspace backend contracts this deployment
 * supports for the caller (Q-14). Contract and states: lib/workspace-data/features.ts.
 * (Not to be confused with GET /api/v1/chat/capabilities, the @-picker tool catalogue.)
 *   200 {contract: 'workspace-features/1', features: {<key>: {state, missingMigrations?, reason?}}}
 *   401 no session        503 STORE_UNAVAILABLE (probe failed; treat every feature as unknown)
 * Read-only, no rows read, no secrets; private, no-store.
 */
import { NextResponse } from 'next/server';
import { errorResponse, ok, workspaceContext } from '@/lib/workspace-data/http';
import { FeatureProbeError, workspaceFeatures, type ProbeDb } from '@/lib/workspace-data/features';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try { return ok(await workspaceFeatures(ctx.db as unknown as ProbeDb)); }
  catch (e) {
    // Operational signal only: probe name and PostgREST/Postgres error code; no row data, no message text.
    console.error(JSON.stringify({ event: 'workspace.features.probe_failed',
      probe: e instanceof FeatureProbeError ? e.probe : 'unknown', code: e instanceof FeatureProbeError ? (e.code ?? null) : (e instanceof Error ? e.name : 'unknown') }));
    return errorResponse(503, 'STORE_UNAVAILABLE');
  }
}
