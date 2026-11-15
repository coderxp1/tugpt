import type { Metadata } from 'next';
import { configuredModels, publicModels } from '@/lib/chat/models';
import { asChatDb, listThreads, type ThreadSummary } from '@/lib/chat/store';
import { getSessionContext } from '@/lib/tenant/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { ChatWorkspace } from '@/components/chat/ChatWorkspace';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Chat · TuGPT' };

/**
 * The first page of the person's own chats is rendered on the server so the
 * list is there on first paint instead of flashing "Loading chats…". It uses
 * the same RLS-scoped client, organization and user as GET /api/v1/chat/threads.
 * When the request selected an organization the user is not a member of, or the
 * read fails, it passes null and the client loads (and can retry) on its own.
 */
async function initialThreads(): Promise<ThreadSummary[] | null> {
  const session = await getSessionContext();
  if (!session?.tenant || session.requestedTenantRejected) return null;
  try {
    return await listThreads(asChatDb(await createAuthenticatedServerClient()), session.tenant.organizationId, session.userId);
  } catch { return null; }
}

export default async function ChatPage() {
  return <ChatWorkspace models={publicModels(configuredModels())} initialThreads={await initialThreads()} />;
}
