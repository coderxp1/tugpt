import { DraftDetail } from '@/components/drafts/DraftDetail';
import { FeatureUnavailable } from '@/components/hub/FeatureUnavailable';
import { blockedFeature } from '@/lib/hub/gate.server';

export const dynamic = 'force-dynamic';

export default async function DraftDetailPage({ params }: { params: Promise<{ draftId: string }> }) {
  const off = await blockedFeature('drafts');
  if (off) return <FeatureUnavailable feature={off} about="AI Drafts lets your team review, edit and approve replies that TuGPT drafts for customer conversations." />;
  const { draftId } = await params;
  return <DraftDetail draftId={draftId} />;
}
