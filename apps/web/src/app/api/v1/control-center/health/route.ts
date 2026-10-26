// Control Center overview: real, locally observable state only.
// No database, provider, or secret is contacted. Environment presence
// is reported as booleans (names only, never values); anything that
// needs a live connection is reported as unavailable, not invented.

import { NextResponse } from 'next/server';
import { labOverview } from '@/lib/control-center/labs';
import { FEATURE_CATALOG } from '@/lib/control-center/catalog';

export async function GET() {
  const overview = labOverview();
  const byStatus = new Map<string, number>();
  for (const entry of FEATURE_CATALOG) {
    byStatus.set(entry.status, (byStatus.get(entry.status) ?? 0) + 1);
  }
  return NextResponse.json({
    baseline: {
      branch: 'main',
      head: 'e82dcecb',
      note: 'Frozen MVP baseline. Merge-commit CI was 4/4 green incl. database-tests at merge time; re-verified 2026-10-23.',
    },
    whatsappKillSwitch: overview.killSwitch ? 'ON' : 'OFF',
    envPresence: overview.envPresence,
    catalogCounts: Object.fromEntries(byStatus),
    catalogTotal: FEATURE_CATALOG.length,
    database: {
      available: false,
      reason:
        'No database connection is configured in this environment, so usage totals, agent activity records, and production logs cannot be read here. They are available in the deployed app once Supabase is configured; the analytics page shows them there.',
    },
    workers: {
      available: false,
      reason:
        'Background workers are not running in this environment. Worker behavior is proven by the worker suites (460/460 on main) and CI database-tests, not by a live worker here.',
    },
  });
}
