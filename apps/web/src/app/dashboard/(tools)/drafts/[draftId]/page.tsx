// Stage 5A: Draft detail page (server component)
// Fetches draft detail server-side and renders the DraftDetail client component.

import { DraftDetail } from '@/components/drafts/DraftDetail';

export default async function DraftDetailPage({
  params,
}: {
  params: Promise<{ draftId: string }>;
}) {
  const { draftId } = await params;
  return <DraftDetail draftId={draftId} />;
}