import type { Metadata } from 'next';
import { getSessionContext } from '@/lib/tenant/server';
import { canManageKnowledge } from '@/lib/tenant/roles';
import { LibraryView } from '@/components/workspace/LibraryView';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Library · TuGPT Workspace' };

/**
 * Library. Knowledge entries are loaded in the browser from GET /api/v1/knowledge (session, tenant,
 * feature gate, RLS). The role only decides whether "Manage in Dashboard" is offered; writes are
 * refused by the API and the database for anyone but owners and admins.
 */
export default async function LibraryPage() {
  const session = await getSessionContext().catch(() => null);
  return <LibraryView role={session && !session.requestedTenantRejected ? session.tenant?.role : undefined} canManage={canManageKnowledge(session)} />;
}
