import 'server-only';
import { asChatDb, listThreads, type ThreadSummary } from './store';
import { getSessionContext } from '@/lib/tenant/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';

/**
 * The first page of the person's own chats, rendered on the server so the Workspace sidebar has
 * them on first paint. Same RLS-scoped client, organization and user as GET /api/v1/chat/threads.
 * Returns null (the client then loads, and can retry) when the request selected an organization
 * the person is not a member of, or when the read fails.
 */
export async function initialThreads(): Promise<ThreadSummary[] | null> {
  const session = await getSessionContext();
  if (!session?.tenant || session.requestedTenantRejected) return null;
  try {
    return await listThreads(asChatDb(await createAuthenticatedServerClient()), session.tenant.organizationId, session.userId);
  } catch { return null; }
}
