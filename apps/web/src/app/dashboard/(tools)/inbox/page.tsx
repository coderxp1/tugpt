import { ConversationInbox } from '@/components/inbox/ConversationInbox';
import { FeatureUnavailable } from '@/components/hub/FeatureUnavailable';
import { blockedFeature } from '@/lib/hub/gate.server';
import { getSessionContext } from '@/lib/tenant/server';

export const dynamic = 'force-dynamic';

/**
 * The viewer's id is resolved here, on the server, and handed down: the API
 * takes the reviewer from the session, this prop only lets the button say the
 * right thing. When the organization does not have Conversations, the page
 * says so instead of loading a list that can only fail.
 */
export default async function InboxPage() {
  const off = await blockedFeature('inbox');
  if (off) return <FeatureUnavailable feature={off} about="Conversations collects customer messages, such as WhatsApp, that are waiting for your team." />;
  const session = await getSessionContext();
  return <ConversationInbox viewerId={session?.userId ?? null} />;
}
