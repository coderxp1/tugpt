// Control Center overview: real, observable state only.
//
// Everything here is either read from this process (env presence as
// booleans, runtime, access mode, kill-switch default, catalog counts) or
// probed live (Supabase reachability). Nothing is hardcoded to a value that
// was true once on somebody's machine. Secret values are never returned —
// presence booleans and the probed host origin only. Anything this process
// genuinely cannot observe (worker liveness) says so instead of guessing.

import { NextResponse } from 'next/server';
import { labOverview } from '@/lib/control-center/labs';
import { FEATURE_CATALOG } from '@/lib/control-center/catalog';
import { resolveAccessMode } from '@/lib/control-center/access';
import { probeDatabase } from '@/lib/control-center/probes';

// The response reflects live state; never let Next cache it.
export const dynamic = 'force-dynamic';

const startedAt = new Date().toISOString();

export async function GET() {
  const overview = labOverview();
  const byStatus = new Map<string, number>();
  for (const entry of FEATURE_CATALOG) {
    byStatus.set(entry.status, (byStatus.get(entry.status) ?? 0) + 1);
  }
  const access = resolveAccessMode(process.env.NODE_ENV, process.env.CONTROL_CENTER_TOKEN);
  const database = await probeDatabase();

  return NextResponse.json(
    {
      runtime: {
        nodeEnv: process.env.NODE_ENV ?? null,
        nodeVersion: process.version,
        startedAt,
        uptimeSeconds: Math.round(process.uptime()),
        // Populated by the image build / deploy when it exports them; null
        // otherwise. Never a literal commit written into source code.
        build: {
          sha: process.env.TUGPT_GIT_SHA ?? null,
          branch: process.env.TUGPT_GIT_BRANCH ?? null,
        },
      },
      access: {
        mode: access.mode,
        tokenConfigured: access.token !== null,
        weakToken: access.weakToken,
      },
      whatsappKillSwitch: overview.killSwitch ? 'ON' : 'OFF',
      envPresence: overview.envPresence,
      catalogCounts: Object.fromEntries(byStatus),
      catalogTotal: FEATURE_CATALOG.length,
      database,
      workers: {
        available: false,
        observable: false,
        reason:
          'The web process has no channel to the background workers — there is no heartbeat table or status endpoint yet — so their liveness cannot be observed from here. Check `docker compose ps` / worker logs on the host. Worker behavior itself is covered by the worker test suite and CI database tests.',
      },
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
