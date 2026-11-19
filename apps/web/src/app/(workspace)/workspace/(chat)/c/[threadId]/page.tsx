import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { isThreadId } from '@/lib/workspace/routes';

export const metadata: Metadata = { title: 'Chat · TuGPT Workspace' };

/**
 * One chat. The (chat) layout renders it and loads the thread through GET /api/v1/chat/threads/[id]
 * with the person's RLS-bound client, so someone else's id shows "This chat could not be opened".
 * An address that is not a thread id at all goes back to a new chat.
 */
export default async function ChatPage({ params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  if (!isThreadId(threadId)) redirect('/workspace');
  return null;
}
