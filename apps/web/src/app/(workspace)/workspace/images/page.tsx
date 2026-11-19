import type { Metadata } from 'next';
import s from '@/components/workspace/pages.module.css';
import { ImageStudio } from '@/components/create/ImageStudio';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Images · TuGPT Workspace' };

/**
 * Images in the Workspace: the existing Create studio (components/create/ImageStudio.tsx) and its
 * API (/api/v1/create/images: owner-only history, private EU GPU). Nothing new on the server.
 */
export default function WorkspaceImagesPage() {
  return (
    <div className={s.page}>
      <div className={s.inner}>
        <header className={s.head}>
          <p className={s.eyebrow}>Images</p>
          <h1>Create images, privately</h1>
          <p>Generation runs on TuGPT&rsquo;s own EU GPU. Your prompts and results are not sent to third-party image services, and only you can see your history.</p>
        </header>
        <ImageStudio />
      </div>
    </div>
  );
}
