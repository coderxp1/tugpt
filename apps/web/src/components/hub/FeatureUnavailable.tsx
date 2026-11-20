'use client';

import Link from 'next/link';
import { stateLabel, type FeatureStatus } from '@/lib/hub/features';
import { useT } from '@/i18n/provider';
import s from '@/components/connect/connect.module.css';

const ABOUT = new Set(['inbox', 'drafts', 'knowledge', 'media']);

/**
 * Honest page for a feature this organization cannot use. It renders no form,
 * no Retry and no button that looks like it would work: only what the feature
 * is, why it is off, and where to go instead.
 */
export function FeatureUnavailable({ feature, about }: { feature: FeatureStatus; about?: string }) {
  const t = useT();
  const text = ABOUT.has(feature.key) ? t(`unavail.about.${feature.key as 'inbox'}`) : about ?? '';
  return (
    <div className={s.page}>
      <header className={s.head}>
        <p className={s.eyebrow}>{feature.name}</p>
        <h1>{t(feature.state === 'not_implemented' ? 'unavail.titleNotYet' : 'unavail.titleOff', { name: feature.name })}</h1>
        {text && <p>{text}</p>}
      </header>
      <section className={s.card} aria-labelledby="feature-off-h" data-feature={feature.key} data-state={feature.state}>
        <div className={s.cardHead}>
          <h2 id="feature-off-h">{t('unavail.statusH')}</h2>
          <span className={`${s.badge} ${s.off}`}>{stateLabel(feature.state, t)}</span>
        </div>
        <p className={s.next}>{feature.detail}</p>
        <p className={s.muted}>{t('unavail.nothing')}</p>
        <div className={s.actions}>
          <Link className={s.primary} href="/dashboard/chat" prefetch={false}>{t('unavail.openChat')}</Link>
          <Link className={s.secondary} href="/dashboard/settings#features" prefetch={false}>{t('unavail.allStatuses')}</Link>
        </div>
      </section>
    </div>
  );
}
