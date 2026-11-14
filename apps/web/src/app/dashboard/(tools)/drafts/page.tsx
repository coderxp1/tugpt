// Stage 5A: Draft inbox page (server component)
// Fetches draft list server-side and renders the DraftInbox client component.

import { DraftInbox } from '@/components/drafts/DraftInbox';

export default async function DraftsPage() {
  return <DraftInbox />;
}