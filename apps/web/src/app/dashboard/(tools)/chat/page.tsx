import type { Metadata } from 'next';
import { configuredModels, publicModels } from '@/lib/chat/models';
import { ChatWorkspace } from '@/components/chat/ChatWorkspace';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Chat · TuGPT' };

export default function ChatPage() {
  return <ChatWorkspace models={publicModels(configuredModels())} />;
}
