'use client';

import type { BackendGap } from '@/lib/connect-ui/contract';
import { useT } from '@/i18n/provider';
import s from './connect.module.css';

/**
 * States plainly, in customer words, that something is not available yet.
 * The internal dependency id stays on the element (data-gap) for support and
 * tests; the technical "needs" text is never shown to customers.
 */
export function GapNote({ gap, children, label }: { gap: BackendGap; children?: React.ReactNode; label?: string }) {
  const t = useT();
  return (
    <div className={s.gap} role="note" data-gap={gap.id}>
      <strong>{label ?? t('connect.gap.notYet')}</strong>
      <span>{children ?? t('connect.gap.notYet')}</span>
    </div>
  );
}
