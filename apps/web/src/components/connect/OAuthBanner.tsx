'use client';

import { useEffect, useRef, useState } from 'react';
import s from './connect.module.css';

export interface OAuthBannerProps { tone: 'ok' | 'error'; title: string; body: string }

/**
 * Result of the provider round trip. Focused once so screen readers announce
 * it; the query string is removed so a reload does not repeat a stale message.
 */
export function OAuthBanner({ tone, title, body }: OAuthBannerProps) {
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const url = new URL(window.location.href);
    for (const k of ['google', 'microsoft', 'reason']) url.searchParams.delete(k);
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }, []);
  if (!open) return null;
  return (
    <div ref={ref} tabIndex={-1} className={`${s.banner} ${tone === 'ok' ? s.bannerOk : s.bannerError}`} role={tone === 'ok' ? 'status' : 'alert'}>
      <div><strong>{title}</strong><p>{body}</p></div>
      <button type="button" className={s.dismiss} onClick={() => setOpen(false)} aria-label="Dismiss message">×</button>
    </div>
  );
}
