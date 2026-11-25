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

type NavItem = { href: string; title: MessageKey; icon: ProductGlyph; feature?: FeatureKey };
/** Every entry is a real page. Pages for features that are off explain why and who can switch them on. */
const workspaceNav: readonly NavItem[] = [
  { href: '/workspace', title: 'shell.item.chat', icon: 'chat', feature: 'chat' },
  { href: '/workspace/library', title: 'shell.item.library', icon: 'book', feature: 'library' },
  { href: '/workspace/approvals', title: 'shell.item.approvals', icon: 'draft', feature: 'approvals' },
  { href: '/workspace/images', title: 'shell.item.images', icon: 'spark', feature: 'images' },
  { href: '/workspace/agents', title: 'shell.item.customAgents', icon: 'spark', feature: 'custom_agents' },
];
const orgNav: readonly NavItem[] = [
  { href: '/dashboard/connect', title: 'shell.item.integrations', icon: 'plug' },
  { href: '/dashboard/settings', title: 'shell.item.team', icon: 'book' },
  { href: '/dashboard/analytics', title: 'shell.item.analytics', icon: 'chart', feature: 'analytics' },
];
const messagingNav: readonly NavItem[] = [
  { href: '/dashboard/inbox', title: 'shell.item.inbox', icon: 'chat', feature: 'inbox' },
  { href: '/dashboard/drafts', title: 'shell.item.drafts', icon: 'draft', feature: 'drafts' },
  { href: '/dashboard/knowledge', title: 'shell.item.knowledge', icon: 'book', feature: 'knowledge' },
  { href: '/dashboard/media', title: 'shell.item.media', icon: 'film', feature: 'media' },
];
/** Dashboard pages, for the breadcrumb and aria-current (Workspace pages have their own frame). */
const destinations: readonly { href: string; title: MessageKey }[] = [
  { href: '/dashboard/chat', title: 'shell.item.chat' },
  { href: '/dashboard/create', title: 'shell.item.create' },
  ...orgNav, ...messagingNav,
];
/** A tag is shown for anything that is not plainly usable; "partial" works and needs no tag in the menu. */
const tagged = (st: FeatureState | undefined) => st !== undefined && st !== 'available' && st !== 'partial';
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
  const navLink = (item: NavItem) => {
    // A feature-backed entry with no reported state is shown as "Couldn't check", never as plainly usable.
    const state = item.feature ? features[item.feature] ?? 'unknown' : undefined;
    const tag = tagged(state) ? stateLabel(state!, t) : null;
    const active = current?.href === item.href;
    return (
      <Link key={item.href} href={item.href} prefetch={false} onClick={follow} className={`${s.sideBtn} ${active ? s.current : ''} ${tag ? s.unavailable : ''}`} aria-current={active ? 'page' : undefined} data-state={state}>
        <Glyph name={item.icon} /><span className={s.sideText}>{t(item.title)}{tag && <><span className={s.sr}>, </span><small className={s.sideState}>{tag}</small></>}</span>
      </Link>
    );
  };
  return <div className={s.layout}>
    <a href="#contenido" className={s.skip}>{t('shell.skip')}</a>
    <aside id="dashboard-sidebar" ref={sidebar} className={`${s.sidebar} ${open ? s.open : ''}`} aria-label={t('shell.nav.aria')}>
      <Link href="/dashboard" className={s.brand} aria-label={t('shell.brandAria')} prefetch={false} onClick={follow}><TuGPTMark size={32} />tugpt</Link>
      <button type="button" className={s.mobileClose} onClick={close} aria-label={t('shell.close')}>×</button>
      <Link href="/workspace" prefetch={false} onClick={follow} className={s.sideWorkspace} data-testid="nav-open-workspace">{t('shell.openWorkspaceNav')} <span aria-hidden="true">→</span></Link>
      <nav className={s.sideNav} aria-label={t('shell.nav.overviewAria')}>
        <Link href="/dashboard" prefetch={false} onClick={follow} className={`${s.sideBtn} ${overview ? s.current : ''}`} aria-current={overview ? 'page' : undefined}><Glyph name="chart" /><span>{t('shell.item.overview')}</span></Link>
      </nav>
      <div className={s.sideLabel} id="nav-workspace">{t('shell.section.workspace')}</div>
      <nav className={s.sideNav} aria-labelledby="nav-workspace">{workspaceNav.map(navLink)}</nav>
      <div className={s.sideLabel} id="nav-org">{t('shell.section.organization')}</div>
      <nav className={s.sideNav} aria-labelledby="nav-org">{orgNav.map(navLink)}</nav>
      <div className={s.sideLabel} id="nav-messaging">{t('shell.section.messaging')}</div>
      <nav className={s.sideNav} aria-labelledby="nav-messaging">{messagingNav.map(navLink)}</nav>
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
