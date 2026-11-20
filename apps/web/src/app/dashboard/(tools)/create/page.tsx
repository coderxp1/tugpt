import type { Metadata } from 'next';
import s from '@/components/connect/connect.module.css';
import { ImageStudio } from '@/components/create/ImageStudio';
import { createTranslator } from '@/i18n';
import { getRequestLocale } from '@/i18n/server';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: createTranslator(await getRequestLocale())('create.metaTitle') };
}

export default async function CreatePage() {
  const t = createTranslator(await getRequestLocale());
  return (
    <div className={s.page}>
      <header className={s.head}>
        <p className={s.eyebrow}>{t('create.eyebrow')}</p>
        <h1>{t('create.title')}</h1>
        <p>{t('create.lead')}</p>
      </header>
      <ImageStudio />
      <ul className={s.grid} style={{ marginTop: 16 }}>
        <li className={s.card}>
          <div className={s.cardHead}><span className={s.logo} aria-hidden="true">V</span><div><h2>{t('create.video.title')}</h2><p>{t('create.video.desc')}</p></div><span className={`${s.badge} ${s.off}`}>{t('create.video.badge')}</span></div>
          <p className={s.next}>{t('create.video.next')}</p>
        </li>
      </ul>
    </div>
  );
}
