// Media job submission page (server component)
// Renders the MediaJobForm client component.

import { MediaJobForm } from '@/components/media/MediaJobForm';

export default async function MediaNewPage() {
  return <MediaJobForm imageOnly={process.env.MEDIA_IMAGE_PROVIDER === 'z-image-turbo'} />;
}
