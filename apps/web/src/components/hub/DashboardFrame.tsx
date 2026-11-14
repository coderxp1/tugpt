'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Glyph, TuGPTMark } from './glyphs';
import type { ProductGlyph } from '@/lib/hub/products';
import s from './reference.module.css';

const modules: readonly { href: string; title: string; icon: ProductGlyph }[] = [
  { href: '/dashboard/inbox', title: 'Conversations', icon: 'chat' },
  { href: '/dashboard/drafts', title: 'AI Drafts', icon: 'draft' },
  { href: '/dashboard/knowledge', title: 'Knowledge', icon: 'book' },
  { href: '/dashboard/media', title: 'Media Studio', icon: 'film' },
  { href: '/settings/integrations', title: 'Integrations', icon: 'calendar' },
  { href: '/dashboard/analytics', title: 'Usage & Costs', icon: 'chart' },
];
export interface DashboardFrameProps {
  organizationName: string | null; email: string | null; role?: string | null;
  children: React.ReactNode; overview?: boolean;
}
export function DashboardFrame({ organizationName, email, role, children, overview = false }: DashboardFrameProps) {
  const pathname = usePathname() ?? '/dashboard';
  const current = modules.find(m => pathname === m.href || pathname.startsWith(m.href + '/'));
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
      const nodes = sidebar.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled])');
      if (!nodes?.length) return;
      const start = nodes[0], end = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === start) { e.preventDefault(); end.focus(); }
      else if (!e.shiftKey && document.activeElement === end) { e.preventDefault(); start.focus(); }
    }
    document.addEventListener('keydown', key);
    return () => { document.body.style.overflow = old; document.removeEventListener('keydown', key); };
  }, [open]);
  function follow() { setOpen(false); window.dispatchEvent(new Event('tugpt:clear-capability-search')); }
  const navLink = (href: string, label: string, glyph: ProductGlyph, active = false) => (
    <Link href={href} prefetch={false} onClick={follow} className={`${s.sideBtn} ${active ? s.current : ''}`} aria-current={active ? 'page' : undefined}>
      <Glyph name={glyph} /><span>{label}</span>
    </Link>
  );
  return <div className={s.layout}>
    <a href="#contenido" className={s.skip}>Skip to content</a>
    <aside id="dashboard-sidebar" ref={sidebar} className={`${s.sidebar} ${open ? s.open : ''}`} aria-label="Dashboard navigation">
      <Link href="/dashboard" className={s.brand} aria-label="TuGPT Dashboard" prefetch={false} onClick={follow}><TuGPTMark size={32} />tugpt</Link>
      <button type="button" className={s.mobileClose} onClick={close} aria-label="Close navigation">×</button>
      <nav className={s.sideNav} aria-label="Overview navigation">
        {navLink('/dashboard', 'Overview', 'chart', overview)}
        <span className={`${s.sideBtn} ${s.unavailable}`}><Glyph name="spark" />Workspace <small className={s.future}>Later</small></span>
      </nav>
      <div className={s.sideLabel}>Your platform</div>
      <nav className={s.sideNav} aria-label="Platform navigation">
        {navLink('/dashboard#group-Connect', 'Connect', 'chat')}
        {navLink('/dashboard#group-Create', 'Create', 'spark')}
        {navLink('/dashboard#group-Operate', 'Operate', 'calendar')}
      </nav>
      <div className={s.sideLabel}>{overview ? 'Explore' : 'Your tools'}</div>
      <nav className={s.sideNav} aria-label="Application modules">
        {modules.filter(m => !overview || m.href.startsWith('/settings') || m.href.endsWith('/analytics')).map(m =>
          <div key={m.href}>{navLink(m.href, m.title, m.icon, current?.href === m.href)}</div>)}
      </nav>
      <div className={s.sideBottom}>One place for work that moves.
        <div className={s.profile}><span className={s.avatar} aria-hidden="true">{organizationName?.charAt(0).toUpperCase() || 'T'}</span>
          <div className={s.identity}><strong>{organizationName ?? 'Organization unavailable'}</strong><small>{role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Organization account'}</small></div>
        </div>
        {email && <span className={s.email}>{email}</span>}
        <Link href="/auth/logout" prefetch={false} className={s.signOut}>Sign out ↗</Link>
      </div>
    </aside>
    {open && <button className={s.backdrop} aria-label="Close navigation backdrop" onClick={close} tabIndex={-1} />}
    <div className={s.main}>
      <header className={s.topbar}>
        <button ref={menu} className={s.mobileMenu} type="button" aria-label="Open navigation" aria-controls="dashboard-sidebar" aria-expanded={open} onClick={() => setOpen(!open)}><span aria-hidden="true">☰</span></button>
        <div className={s.crumb}>TuGPT <span aria-hidden="true"> / </span><strong>{overview ? 'Overview' : current?.title ?? 'Dashboard'}</strong></div>
        <div className={s.topActions}><span className={s.reviewTag}>Review environment</span><span className={s.accountMark} aria-label="Authenticated account">{organizationName?.charAt(0).toUpperCase() || 'T'}</span></div>
      </header>
      <main id="contenido" className={overview ? s.content : s.toolContent}>{children}</main>
    </div>
  </div>;
}
