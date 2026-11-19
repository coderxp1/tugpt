/**
 * The chat lives in this layout, not in the pages, so it stays mounted while the address moves
 * between /workspace (new chat) and /workspace/c/<id> (an open chat): starting a chat, opening one
 * from the sidebar and Back/Forward never interrupt an answer that is streaming. The pages below
 * only make those addresses real routes (and validate the id).
 */
import { configuredModels, publicModels } from '@/lib/chat/models';
import { getSessionContext } from '@/lib/tenant/server';
import { canApproveMcpCalls } from '@/lib/tenant/roles';
import { ChatView } from '@/components/chat/ChatView';
import { firstName } from '@/lib/workspace/greeting';

export default async function ChatLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await getSessionContext().catch(() => null);
  return (
    <>
      <ChatView models={publicModels(configuredModels())} canApprove={canApproveMcpCalls(session)} firstName={firstName(session?.fullName)} />
      {children}
    </>
  );
}
