import Link from 'next/link';
import { STATE_LABEL, type FeatureStatus } from '@/lib/hub/features';
import s from '@/components/connect/connect.module.css';

/**
 * Honest page for a feature this organization cannot use. It renders no form,
 * no Retry and no button that looks like it would work: only what the feature
 * is, why it is off, and where to go instead.
 */
export function FeatureUnavailable({ feature, about }: { feature: FeatureStatus; about: string }) {
  return (
    <div className={s.page}>
      <header className={s.head}>
        <p className={s.eyebrow}>{feature.name}</p>
        <h1>{feature.name} is {feature.state === 'not_implemented' ? 'not available yet' : 'not enabled'}</h1>
        <p>{about}</p>
      </header>
      <section className={s.card} aria-labelledby="feature-off-h" data-feature={feature.key} data-state={feature.state}>
        <div className={s.cardHead}>
          <h2 id="feature-off-h">Status for your organization</h2>
          <span className={`${s.badge} ${s.off}`}>{STATE_LABEL[feature.state]}</span>
        </div>
        <p className={s.next}>{feature.detail}</p>
        <p className={s.muted}>Nothing on this page sends, stores or generates anything while it is off.</p>
        <div className={s.actions}>
          <Link className={s.primary} href="/dashboard/chat" prefetch={false}>Open Chat</Link>
          <Link className={s.secondary} href="/dashboard/settings#features" prefetch={false}>See all feature statuses</Link>
        </div>
      </section>
    </div>
  );
}
