'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { useT } from '@/i18n/provider';
import s from './connect.module.css';

/** Status is read on every request (force-dynamic); this re-reads it without a full reload. */
export function StatusFreshness({ checkedAt }: { checkedAt: string }) {
  const t = useT();
  const router = useRouter();
  const [pending, start] = useTransition();
  const time = new Date(checkedAt);
  return (
    <p className={s.fresh} aria-live="polite">
      <span>{t('connect.fresh.checked')} <time dateTime={checkedAt} suppressHydrationWarning>{time.toLocaleTimeString(t.locale === 'es' ? 'es-EC' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></span>
      <button type="button" className={s.linkButton} onClick={() => start(() => router.refresh())} disabled={pending} aria-busy={pending}>
        {pending ? t('connect.fresh.checking') : t('connect.fresh.again')}
      </button>
    </p>
  );
}
