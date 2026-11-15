'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import s from './connect.module.css';

/** Status is read on every request (force-dynamic); this re-reads it without a full reload. */
export function StatusFreshness({ checkedAt }: { checkedAt: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const time = new Date(checkedAt);
  return (
    <p className={s.fresh} aria-live="polite">
      <span>Status checked <time dateTime={checkedAt} suppressHydrationWarning>{time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></span>
      <button type="button" className={s.linkButton} onClick={() => start(() => router.refresh())} disabled={pending} aria-busy={pending}>
        {pending ? 'Checking…' : 'Check again'}
      </button>
    </p>
  );
}
