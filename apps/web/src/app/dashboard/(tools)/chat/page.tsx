import type { Metadata } from 'next';
import { getSessionContext } from '@/lib/tenant/server';
import { configuredModels, publicModels } from '@/lib/chat/models';
import { ChatWorkspace } from '@/components/chat/ChatWorkspace';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Chat · TuGPT' };

export default async function ChatPage() {
  const session = await getSessionContext();
  return <ChatWorkspace models={publicModels(configuredModels())} organizationName={session?.tenant?.organizationName ?? 'your organization'} />;
}
