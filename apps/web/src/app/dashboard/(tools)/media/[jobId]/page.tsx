import { MediaJobDetail } from '@/components/media/MediaJobDetail';
import { FeatureUnavailable } from '@/components/hub/FeatureUnavailable';
import { blockedFeature } from '@/lib/hub/gate.server';

export const dynamic = 'force-dynamic';

export default async function MediaDetailPage({ params }: { params: Promise<{ jobId: string }> }) {
  const off = await blockedFeature('media');
  if (off) return <FeatureUnavailable feature={off} about="Media Studio turns recordings and uploads into transcripts and generated media." />;
  const { jobId } = await params;
  return <MediaJobDetail jobId={jobId} />;
}
