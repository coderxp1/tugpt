'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useT } from '@/i18n/provider';
import type { MessageKey } from '@/i18n/types';
import { messageKeyFor, type Failure, type ServiceProblem } from '@/lib/workspace/service';
import { Icon, type IconName } from './icons';
import u from './ui.module.css';

/** Skeleton rows while something loads. Announced once, politely. */
export function LoadingRows({ label, rows = 3, tall = false }: { label: string; rows?: number; tall?: boolean }) {
  return (
    <div className={u.loading} aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => <div key={i} className={tall ? u.skeletonTall : u.skeleton} />)}
      <span className={u.sr} role="status">{label}…</span>
    </div>
  );
}

export interface ServiceNoticeProps {
  readonly problem: ServiceProblem;
  readonly failure: Pick<Failure, 'status' | 'error'>;
  /** The feature, e.g. "Collections". Used in the unavailable sentence. */
  readonly feature: string;
  /** Why it matters / what it will do once available. */
  readonly detail?: string;
  onRetry?(): void;
  readonly compact?: boolean;
}

/**
 * The one way the Workspace says a backend call did not work:
 *  - unavailable: a calm, dashed notice ("not available in this workspace yet") and no retry spam;
 *  - signed out: a sign-in link;
 *  - everything else: an alert with the reason and "Try again".
 */
export function ServiceNotice({ problem, failure, feature, detail, onRetry, compact = false }: ServiceNoticeProps) {
  const t = useT();
  if (problem === 'unavailable') {
    return (
      <div className={`${u.notice} ${compact ? u.compact : ''}`}>
        <Icon name="alert" size={16} />
        <div><strong>{t('workspace.state.unavailable', { feature })}</strong>{detail && <p>{detail}</p>}</div>
      </div>
    );
  }
  if (problem === 'signedOut') {
    return <div className={u.error} role="alert"><p>{t('workspace.err.signedOut')}</p><Link className={u.button} href="/auth/login" prefetch={false}>{t('workspace.state.signIn')}</Link></div>;
  }
  return (
    <div className={`${u.error} ${compact ? u.compact : ''}`} role="alert">
      <p>{t('workspace.state.failed', { feature })} {t(messageKeyFor(failure))}</p>
      {onRetry && problem !== 'forbidden' && <button type="button" className={u.button} onClick={onRetry}><Icon name="refresh" size={15} />{t('workspace.tryAgain')}</button>}
    </div>
  );
}

export function EmptyState({ icon, title, body, children }: { icon: IconName; title: string; body?: string; children?: React.ReactNode }) {
  return (
    <div className={u.empty}>
      <span className={u.emptyMark} aria-hidden="true"><Icon name={icon} size={20} /></span>
      <div><strong>{title}</strong>{body && <p>{body}</p>}</div>
      {children && <div className={u.emptyActions}>{children}</div>}
    </div>
  );
}

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={`${u.badge} ${u[`tone_${tone}`]}`}>{children}</span>;
}

/** Relative time ("3 min ago"), with the exact time as a tooltip. */
export function When({ iso, prefix }: { iso: string | null; prefix?: MessageKey }) {
  const t = useT();
  // "Now" is captured once and refreshed every minute, so rendering stays pure.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const diff = (d.getTime() - now) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(t.locale, { numeric: 'auto' });
  const text = abs < 60 ? rtf.format(Math.round(diff), 'second')
    : abs < 3600 ? rtf.format(Math.round(diff / 60), 'minute')
      : abs < 86400 ? rtf.format(Math.round(diff / 3600), 'hour')
        : rtf.format(Math.round(diff / 86400), 'day');
  return <time dateTime={iso} title={d.toLocaleString(t.locale)}>{prefix ? t(prefix, { when: text }) : text}</time>;
}
