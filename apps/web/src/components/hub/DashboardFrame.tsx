'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/provider';
import { Glyph, TuGPTMark } from './glyphs';
import type { ProductGlyph } from '@/lib/hub/products';
import { STATE_LABEL, type FeatureKey, type FeatureState } from '@/lib/hub/features';
import s from './reference.module.css';

const modules: readonly { href: string; title: string; icon: ProductGlyph; feature: FeatureKey; held?: boolean; planned?: boolean }[] = [
  { href: '/dashboard/inbox', title: 'Conversations', icon: 'chat', feature: 'inbox' },
  { href: '/dashboard/drafts', title: 'AI Drafts', icon: 'draft', feature: 'drafts' },
  { href: '/dashboard/knowledge', title: 'Knowledge', icon: 'book', feature: 'knowledge' },
  { href: '/dashboard/media', title: 'Media Studio', icon: 'film', feature: 'media', held: true },
  { href: '/dashboard/analytics', title: 'Usage & Costs', icon: 'chart', feature: 'analytics' },
  { href: '/dashboard/agents', title: 'Agents & workflows', icon: 'spark', feature: 'agents', planned: true },
];
const destinations: readonly { href: string; title: string }[] = [
  { href: '/dashboard/connect', title: 'Connect' },
  { href: '/dashboard/create', title: 'Create' },
  { href: '/dashboard/settings', title: 'Settings' },
  ...modules,
];
const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Administrator', manager: 'Manager', agent: 'Member', viewer: 'Viewer' };
/**
 * The customer-facing frame: the signed-in person and the organization they are
 * working in now (their own active organization only; never another tenant's).
 * Module entries carry the organization's real feature state (lib/hub/features).
 */
export interface DashboardFrameProps {
  fullName?: string | null; email: string | null;
  organizationName?: string | null; role?: string | null;
  features?: Partial<Record<FeatureKey, FeatureState>>;
  children: React.ReactNode; overview?: boolean;
}
export function DashboardFrame({ fullName = null, email, organizationName = null, role = null, features = {}, children, overview = false }: DashboardFrameProps) {
  const t = useT();
  const pathname = usePathname() ?? '/dashboard';
  const current = destinations.find(m => pathname === m.href || pathname.startsWith(m.href + '/'));
  const is = (href: string) => current?.href === href;
  const displayName = fullName || email || 'Your account';
  const initial = displayName.charAt(0).toUpperCase();
  const [open, setOpen] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const menu = useRef<HTMLButtonElement>(null);
  function close() { setOpen(false); menu.current?.focus(); }
  useEffect(() => {
    if (!open) return;
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = sidebar.current?.querySelector<HTMLElement>('a,button'); first?.focus();
    function key(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); menu.current?.focus(); }
      if (e.key !== 'Tab') return;
      const nodes = sidebar.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),select:not([disabled])');
      if (!nodes?.length) return;
      const start = nodes[0], end = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === start) { e.preventDefault(); end.focus(); }
      else if (!e.shiftKey && document.activeElement === end) { e.preventDefault(); start.focus(); }
    }
    document.addEventListener('keydown', key);
    return () => { document.body.style.overflow = old; document.removeEventListener('keydown', key); };
  }, [open]);
  function follow() { setOpen(false); window.dispatchEvent(new Event('tugpt:clear-capability-search')); }
  const navLink = (href: string, label: string, glyph: ProductGlyph, active = false, feature?: FeatureKey) => {
    const state = feature ? features[feature] : undefined;
    const tag = state && state !== 'available' ? STATE_LABEL[state] : null;
    return (
      <Link href={href} prefetch={false} onClick={follow} className={`${s.sideBtn} ${active ? s.current : ''} ${tag && state !== 'partial' ? s.unavailable : ''}`} aria-current={active ? 'page' : undefined} data-state={feature ? state ?? 'unknown' : undefined}>
        <Glyph name={glyph} /><span className={tag ? s.sideText : undefined}>{label}{tag && <><span className={s.sr}>, </span><small className={s.sideState}>{tag}</small></>}</span>
      </Link>
    );
  };
  return <div className={s.layout}>
    <a href="#contenido" className={s.skip}>Skip to content</a>
    <aside id="dashboard-sidebar" ref={sidebar} className={`${s.sidebar} ${open ? s.open : ''}`} aria-label="Dashboard navigation">
      <Link href="/dashboard" className={s.brand} aria-label="TuGPT Dashboard" prefetch={false} onClick={follow}><TuGPTMark size={32} />tugpt</Link>
      <button type="button" className={s.mobileClose} onClick={close} aria-label="Close navigation">×</button>
      <nav className={s.sideNav} aria-label="Overview navigation">
        {navLink('/dashboard', 'Overview', 'chart', overview)}
        {/* Chat moved to the Workspace (Phase 1): same session, separate app frame. */}
        {navLink('/workspace', t('workspace.name'), 'chat')}
      </nav>
      <div className={s.sideLabel}>Your platform</div>
      <nav className={s.sideNav} aria-label="Platform navigation">
        {navLink('/dashboard/connect', 'Connect', 'calendar', is('/dashboard/connect'))}
        {navLink('/dashboard/create', 'Create', 'spark', is('/dashboard/create'), 'images')}
        {navLink('/dashboard/settings', 'Settings', 'book', is('/dashboard/settings'))}
      </nav>
      <div className={s.sideLabel}>Your tools</div>
      <nav className={s.sideNav} aria-label="Application modules">
        {modules.map(m => {
          const state = features[m.feature];
          if (m.planned || m.held) return <div key={m.href}><span className={`${s.sideBtn} ${s.unavailable}`} aria-disabled="true" data-state={m.held ? 'held' : 'planned'}><Glyph name={m.icon} /><span className={s.sideText}>{m.title}<span className={s.sr}>, </span><small className={s.sideState}>{m.held ? t('hub.state.held') : 'Not available yet'}</small></span></span></div>;
          const tag = state && state !== 'available' ? STATE_LABEL[state] : null;
          const active = current?.href === m.href;
          return <div key={m.href}><Link href={m.href} prefetch={false} onClick={follow} className={`${s.sideBtn} ${active ? s.current : ''} ${tag && state !== 'partial' ? s.unavailable : ''}`} aria-current={active ? 'page' : undefined} data-state={state ?? 'unknown'}>
            <Glyph name={m.icon} /><span className={s.sideText}>{m.title}{tag && <><span className={s.sr}>, </span><small className={s.sideState}>{tag}</small></>}</span>
          </Link></div>;
        })}
      </nav>
      <div className={s.sideBottom}>
        <Link href="/dashboard/settings" prefetch={false} onClick={follow} className={s.profile} aria-current={is('/dashboard/settings') ? 'page' : undefined}>
          <span className={s.avatar} aria-hidden="true">{initial}</span>
          <span className={s.identity}><strong className={s.personName}>{displayName}</strong>{fullName && email && <small className={s.personEmail} title={email}>{email}</small>}{organizationName && <small className={s.personEmail} data-testid="active-org" title={organizationName}>{organizationName}{role ? ` · ${ROLE_LABEL[role] ?? role}` : ''}</small>}<small>Profile &amp; settings</small></span>
        </Link>
        <Link href="/auth/logout" prefetch={false} className={s.signOut}>Sign out ↗</Link>
      </div>
    </aside>
    {open && <button className={s.backdrop} aria-label="Close navigation backdrop" onClick={close} tabIndex={-1} />}
    <div className={s.main}>
      <header className={s.topbar}>
        <button ref={menu} className={s.mobileMenu} type="button" aria-label="Open navigation" aria-controls="dashboard-sidebar" aria-expanded={open} onClick={() => setOpen(!open)}><span aria-hidden="true">☰</span></button>
        <div className={s.crumb}>TuGPT <span aria-hidden="true"> / </span><strong>{overview ? 'Overview' : current?.title ?? 'Dashboard'}</strong></div>
        <div className={s.topActions}>{organizationName && <span className={s.topOrg} title="Organization you are working in">{organizationName}</span>}<Link href="/workspace" prefetch={false} className={s.openWorkspace}>{t('dashboard.openWorkspace')}</Link><Link href="/dashboard/settings" prefetch={false} className={s.accountMark} aria-label={`Your account: ${displayName}`}>{initial}</Link></div>
      </header>
      <main id="contenido" className={overview ? s.content : s.toolContent}>{children}</main>
    </div>
  </div>;
}
