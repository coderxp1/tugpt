'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/provider';
import { Glyph, TuGPTMark } from './glyphs';
import type { ProductGlyph } from '@/lib/hub/products';
import { stateLabel, type FeatureKey, type FeatureState } from '@/lib/hub/features';
import s from './reference.module.css';
import type { MessageKey } from '@/i18n/types';
import { roleLabel } from '@/lib/team/roles';

const modules: readonly { href: string; title: MessageKey; icon: ProductGlyph; feature: FeatureKey; held?: boolean; planned?: boolean }[] = [
  { href: '/dashboard/inbox', title: 'shell.item.inbox', icon: 'chat', feature: 'inbox' },
  { href: '/dashboard/drafts', title: 'shell.item.drafts', icon: 'draft', feature: 'drafts' },
  { href: '/dashboard/knowledge', title: 'shell.item.knowledge', icon: 'book', feature: 'knowledge' },
  { href: '/dashboard/media', title: 'shell.item.media', icon: 'film', feature: 'media', held: true },
  { href: '/dashboard/analytics', title: 'shell.item.analytics', icon: 'chart', feature: 'analytics' },
  { href: '/dashboard/agents', title: 'shell.item.agents', icon: 'spark', feature: 'agents', planned: true },
];
const destinations: readonly { href: string; title: MessageKey }[] = [
  { href: '/dashboard/chat', title: 'shell.item.chat' },
  { href: '/dashboard/connect', title: 'shell.item.connect' },
  { href: '/dashboard/create', title: 'shell.item.create' },
  { href: '/dashboard/settings', title: 'shell.item.settings' },
  ...modules,
];
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
  const displayName = fullName || email || t('shell.yourAccount');
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
    const tag = state && state !== 'available' ? stateLabel(state, t) : null;
    return (
      <Link href={href} prefetch={false} onClick={follow} className={`${s.sideBtn} ${active ? s.current : ''} ${tag && state !== 'partial' ? s.unavailable : ''}`} aria-current={active ? 'page' : undefined} data-state={feature ? state ?? 'unknown' : undefined}>
        <Glyph name={glyph} /><span className={tag ? s.sideText : undefined}>{label}{tag && <><span className={s.sr}>, </span><small className={s.sideState}>{tag}</small></>}</span>
      </Link>
    );
  };
  return <div className={s.layout}>
    <a href="#contenido" className={s.skip}>{t('shell.skip')}</a>
    <aside id="dashboard-sidebar" ref={sidebar} className={`${s.sidebar} ${open ? s.open : ''}`} aria-label={t('shell.nav.aria')}>
      <Link href="/dashboard" className={s.brand} aria-label={t('shell.brandAria')} prefetch={false} onClick={follow}><TuGPTMark size={32} />tugpt</Link>
      <button type="button" className={s.mobileClose} onClick={close} aria-label={t('shell.close')}>×</button>
      <nav className={s.sideNav} aria-label={t('shell.nav.overviewAria')}>
        {navLink('/dashboard', t('shell.item.overview'), 'chart', overview)}
        {/* Chat moved to the Workspace (Phase 1): same session, separate app frame. */}
        {navLink('/workspace', t('workspace.name'), 'chat')}
      </nav>
      <div className={s.sideLabel}>{t('shell.section.platform')}</div>
      <nav className={s.sideNav} aria-label={t('shell.nav.platformAria')}>
        {navLink('/dashboard/connect', t('shell.item.connect'), 'calendar', is('/dashboard/connect'))}
        {navLink('/dashboard/create', t('shell.item.create'), 'spark', is('/dashboard/create'), 'images')}
        {navLink('/dashboard/settings', t('shell.item.settings'), 'book', is('/dashboard/settings'))}
      </nav>
      <div className={s.sideLabel}>{t('shell.section.tools')}</div>
      <nav className={s.sideNav} aria-label={t('shell.nav.modulesAria')}>
        {modules.map(m => {
          const state = features[m.feature];
          if (m.planned || m.held) return <div key={m.href}><span className={`${s.sideBtn} ${s.unavailable}`} aria-disabled="true" data-state={m.held ? 'held' : 'planned'}><Glyph name={m.icon} /><span className={s.sideText}>{t(m.title)}<span className={s.sr}>, </span><small className={s.sideState}>{m.held ? t('hub.state.held') : t('shell.notYet')}</small></span></span></div>;
          const tag = state && state !== 'available' ? stateLabel(state, t) : null;
          const active = current?.href === m.href;
          return <div key={m.href}><Link href={m.href} prefetch={false} onClick={follow} className={`${s.sideBtn} ${active ? s.current : ''} ${tag && state !== 'partial' ? s.unavailable : ''}`} aria-current={active ? 'page' : undefined} data-state={state ?? 'unknown'}>
            <Glyph name={m.icon} /><span className={s.sideText}>{t(m.title)}{tag && <><span className={s.sr}>, </span><small className={s.sideState}>{tag}</small></>}</span>
          </Link></div>;
        })}
      </nav>
      <div className={s.sideBottom}>
        <Link href="/dashboard/settings" prefetch={false} onClick={follow} className={s.profile} aria-current={is('/dashboard/settings') ? 'page' : undefined}>
          <span className={s.avatar} aria-hidden="true">{initial}</span>
          <span className={s.identity}><strong className={s.personName}>{displayName}</strong>{fullName && email && <small className={s.personEmail} title={email}>{email}</small>}{organizationName && <small className={s.personEmail} data-testid="active-org" title={organizationName}>{organizationName}{role ? ` · ${roleLabel(role, t)}` : ''}</small>}<small>{t('shell.profileSettings')}</small></span>
        </Link>
        <Link href="/auth/logout" prefetch={false} className={s.signOut}>{t('shell.signOut')} ↗</Link>
      </div>
    </aside>
    {open && <button className={s.backdrop} aria-label={t('shell.backdrop')} onClick={close} tabIndex={-1} />}
    <div className={s.main}>
      <header className={s.topbar}>
        <button ref={menu} className={s.mobileMenu} type="button" aria-label={t('shell.openNav')} aria-controls="dashboard-sidebar" aria-expanded={open} onClick={() => setOpen(!open)}><span aria-hidden="true">☰</span></button>
        <div className={s.crumb}>TuGPT <span aria-hidden="true"> / </span><strong>{overview ? t('shell.item.overview') : current ? t(current.title) : t('shell.crumbDashboard')}</strong></div>
        <div className={s.topActions}>{organizationName && <span className={s.topOrg} title={t('shell.orgTitle')}>{organizationName}</span>}<Link href="/workspace" prefetch={false} className={s.openWorkspace}>{t('dashboard.openWorkspace')}</Link><Link href="/dashboard/settings" prefetch={false} className={s.accountMark} aria-label={t('shell.accountAria', { name: displayName })}>{initial}</Link></div>
      </header>
      <main id="contenido" tabIndex={-1} className={overview ? s.content : s.toolContent}>{children}</main>
    </div>
  </div>;
}
