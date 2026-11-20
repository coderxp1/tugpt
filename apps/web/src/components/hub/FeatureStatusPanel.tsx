'use client';

import Link from 'next/link';
import { stateLabel, type FeatureState, type FeatureStatus } from '@/lib/hub/features';
import { useT } from '@/i18n/provider';
import s from '@/components/connect/connect.module.css';

const TONE: Record<FeatureState, string> = { available: s.ok, partial: s.idle, disabled: s.off, not_implemented: s.off };

/** What this organization can use now. Read from the real gates; nothing here can be toggled. */
export function FeatureStatusPanel({ features }: { features: readonly FeatureStatus[] }) {
  const t = useT();
  return (
    <section className={s.section} aria-labelledby="features-h" id="features">
      <h2 id="features-h">{t('feature.title')}</h2>
      <p className={s.lead}>{t('feature.lead')}</p>
      <div className={s.tableWrap}><table className={`${s.table} ${s.stack}`}>
        <caption className={s.sr}>{t('feature.caption')}</caption>
        <thead><tr><th scope="col">{t('feature.col.feature')}</th><th scope="col">{t('feature.col.status')}</th><th scope="col">{t('feature.col.meaning')}</th></tr></thead>
        <tbody>{features.map((f) => (
          <tr key={f.key} data-feature={f.key} data-state={f.state}>
            <th scope="row">{f.href ? <Link href={f.href} prefetch={false}>{f.name}</Link> : f.name}</th>
            <td data-label={t('feature.col.status')}><span className={`${s.badge} ${TONE[f.state]}`}>{stateLabel(f.state, t)}</span></td>
            <td data-label={t('feature.col.meaning')}>{f.detail}</td>
          </tr>))}
        </tbody>
      </table></div>
    </section>
  );
}
