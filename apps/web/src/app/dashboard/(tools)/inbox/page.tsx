import { ConversationInbox } from '@/components/inbox/ConversationInbox';
import { getSessionContext } from '@/lib/tenant/server';

/**
 * The viewer's id is resolved here, on the server, and handed down.
 *
 * "Claim" means "assign to me", and the client has to name whom. Letting the
 * browser supply that id would mean a caller could claim a conversation on a
 * colleague's behalf — or read the `mine` queue as somebody else — by editing
 * a request. The API takes the reviewer from the session for exactly that
 * reason; this prop only lets the button say the right thing.
 */
export default async function InboxPage() {
  const session = await getSessionContext();
  return <ConversationInbox viewerId={session?.userId ?? null} />;
}
