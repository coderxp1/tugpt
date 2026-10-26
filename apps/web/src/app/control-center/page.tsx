// TuGPT Product Control Center — public page shell.
//
// Deliberately outside /dashboard: the dashboard layout resolves a
// tenant session, and this page must open without one so the owner
// can inspect real product state and run the safe in-process labs.
// The page itself renders no tenant data; the health and lab APIs it
// calls are public by the same rule as /api/v1/health (no tenant
// data, no secrets, no writes) and are classified in proxy.ts.

import { ControlCenter } from '@/components/control-center/ControlCenter';

export default function ControlCenterPage() {
  return <ControlCenter />;
}
