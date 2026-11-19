import type { Metadata } from 'next';
import { getSessionContext } from '@/lib/tenant/server';
import { canApproveMcpCalls } from '@/lib/tenant/roles';
import { ApprovalsView } from '@/components/workspace/ApprovalsView';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Approvals · TuGPT Workspace' };

/**
 * Approval history and decisions. Data is loaded in the browser from GET /api/v1/approvals
 * (session, tenant, RLS). The role only decides which controls are offered; the API and the
 * database check it again for every list (scope=org) and every decision.
 */
export default async function ApprovalsPage() {
  const session = await getSessionContext().catch(() => null);
  return <ApprovalsView canDecide={canApproveMcpCalls(session)} userId={session?.userId ?? null} />;
}
