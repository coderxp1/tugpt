import { DraftInbox } from '@/components/drafts/DraftInbox';
import { FeatureUnavailable } from '@/components/hub/FeatureUnavailable';
import { blockedFeature } from '@/lib/hub/gate.server';

export const dynamic = 'force-dynamic';
const ABOUT = 'AI Drafts lets your team review, edit and approve replies that TuGPT drafts for customer conversations.';

export default async function DraftsPage() {
  const off = await blockedFeature('drafts');
  if (off) return <FeatureUnavailable feature={off} about={ABOUT} />;
  return <DraftInbox />;
}
