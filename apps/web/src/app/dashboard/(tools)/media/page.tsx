import { MediaJobList } from '@/components/media/MediaJobList';
import { FeatureUnavailable } from '@/components/hub/FeatureUnavailable';
import { blockedFeature } from '@/lib/hub/gate.server';

export const dynamic = 'force-dynamic';

/** Media Studio is held platform-wide (its API is fenced); the page never shows a form that cannot submit. */
export default async function MediaPage() {
  const off = await blockedFeature('media');
  if (off) return <FeatureUnavailable feature={off} about="Media Studio turns recordings and uploads into transcripts and generated media." />;
  return <MediaJobList />;
}
