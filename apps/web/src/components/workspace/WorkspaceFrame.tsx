'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/provider';
import { TuGPTMark } from '@/components/hub/glyphs';
import { ThreadList } from '@/components/chat/ThreadList';
import { WORKSPACE_HOME, isSectionPath, threadIdFromPath } from '@/lib/workspace/routes';
import { WORKSPACE_APPROVALS_SECTION, WORKSPACE_SECTIONS, WORKSPACE_UPCOMING } from '@/lib/workspace/nav';
import { Icon } from './icons';
import { ProfileMenu } from './ProfileMenu';
import { useThreads } from './ThreadsProvider';
import { useApprovalFeed } from './useApprovalFeed';
import s from './workspace.module.css';

export interface WorkspaceFrameProps {
  readonly fullName?: string | null;
  readonly email: string | null;
  /** Owner/admin of the active organization (UI hint; the approvals API checks the role again). */
  readonly canDecide?: boolean;
  readonly children: React.ReactNode;
}

const FOCUSABLE = 'a[href]:not([aria-disabled="true"]),button:not([disabled]),input:not([disabled]),summary';

/**
 * The Workspace frame: where people work with AI. Separate from the Dashboard (management), sharing
 * its session, organization and backend. Left: New chat, search, the Workspace areas, recent chats,
 * the way to the Dashboard and the person's account menu. At 1024px and up the sidebar can be
 * collapsed; below that it is a drawer behind a menu button, with a focus trap.
 * Like the Dashboard it shows the signed-in person, never the organization's name.
 */
export function WorkspaceFrame({ fullName = null, email, canDecide = false, children }: WorkspaceFrameProps) {
  const t = useT();
  const pathname = usePathname() ?? WORKSPACE_HOME;
  const { threads, failed, retry, busy } = useThreads();
  const activeThread = threadIdFromPath(pathname);
  const approvals = useApprovalFeed(canDecide);
  const sections = approvals.available === 'available' ? [...WORKSPACE_SECTIONS, WORKSPACE_APPROVALS_SECTION] : WORKSPACE_SECTIONS;
  const latest = approvals.decided[0];
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState('');
  const sidebar = useRef<HTMLElement>(null);
  const menu = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const isDesktop = () => typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1024px)').matches;
  function close() { setOpen(false); menu.current?.focus(); }
  function follow() { setOpen(false); }
  function toggleMenu() {
    if (collapsed && isDesktop()) { setCollapsed(false); return; }
    setOpen((o) => !o);
  }

  // Ctrl/Cmd+K: search chats, from anywhere in the Workspace.
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (!isDesktop()) setOpen(true);
        setCollapsed(false);
        requestAnimationFrame(() => search.current?.focus());
      }
    }
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);

  useEffect(() => {
    if (!open) return;
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Next frame: the drawer must be rendered visible before it can take focus.
    const raf = requestAnimationFrame(() => {
      if (!sidebar.current?.contains(document.activeElement)) sidebar.current?.querySelector<HTMLElement>('a[href],button:not([disabled])')?.focus();
    });
    function key(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); menu.current?.focus(); return; }
      if (e.key !== 'Tab') return;
      const nodes = sidebar.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes?.length) return;
      const start = nodes[0], end = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === start) { e.preventDefault(); end.focus(); }
      else if (!e.shiftKey && document.activeElement === end) { e.preventDefault(); start.focus(); }
    }
    document.addEventListener('keydown', key);
    return () => { cancelAnimationFrame(raf); document.body.style.overflow = old; document.removeEventListener('keydown', key); };
  }, [open]);

  return (
    <div className={`${s.frame} ${collapsed ? s.collapsed : ''}`}>
      <a href="#workspace-main" className={s.skip}>{t('shell.skipToContent')}</a>
      <aside id="workspace-sidebar" ref={sidebar} className={`${s.sidebar} ${open ? s.open : ''}`} aria-label={t('workspace.sidebarLabel')}>
        <div className={s.head}>
          <Link href={WORKSPACE_HOME} prefetch={false} className={s.brand} aria-label={t('workspace.brandLabel')} onClick={follow}>
            <TuGPTMark size={26} /><span className={s.word}>tugpt</span><span className={s.app}>{t('workspace.name')}</span>
          </Link>
          <button type="button" className={s.collapse} onClick={() => setCollapsed(true)} aria-label={t('workspace.collapseSidebar')} title={t('workspace.collapseSidebar')}>
            <Icon name="sidebar" />
          </button>
          <button type="button" className={s.close} onClick={close} aria-label={t('workspace.closeMenu')}><Icon name="close" /></button>
        </div>

        <Link href={WORKSPACE_HOME} prefetch={false} className={s.newChat}
          aria-disabled={busy ? 'true' : undefined}
          onClick={(e) => { if (busy) { e.preventDefault(); return; } follow(); }}>
          <Icon name="plus" /><span>{t('workspace.newChat')}</span>
        </Link>

        <div className={s.search} role="search">
          <Icon name="search" size={16} />
          <label htmlFor="workspace-search" className={s.sr}>{t('workspace.searchChats')}</label>
          <input id="workspace-search" ref={search} type="search" value={query} placeholder={t('workspace.searchChats')} autoComplete="off" spellCheck={false}
            onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); e.preventDefault(); setQuery(''); } }} />
          <kbd className={s.kbd} aria-hidden="true">⌘K</kbd>
        </div>

        <nav className={s.nav} aria-label={t('workspace.navLabel')}>
          {sections.map((sec) => {
            const current = isSectionPath(pathname, sec.href);
            const count = sec.key === 'approvals' ? approvals.pending : 0;
            return (
              <Link key={sec.key} href={sec.href} prefetch={false} onClick={follow} className={`${s.navItem} ${current ? s.current : ''}`} aria-current={current ? 'page' : undefined}>
                <Icon name={sec.key} /><span>{t(sec.labelKey)}</span>
                {count > 0 && <span className={s.navBadge}><span aria-hidden="true">{count > 49 ? '50+' : count}</span><span className={s.sr}>, {t(canDecide ? 'workspace.approvals.waitingCount' : 'workspace.approvals.mineCount', { count })}</span></span>}
              </Link>
            );
          })}
        </nav>

        <ThreadList threads={threads} failed={failed} activeId={activeThread} busy={busy} query={query} onRetry={retry} onOpen={follow} />

        <details className={s.later}>
          <summary>{t('workspace.comingLater')}</summary>
          <ul>
            {WORKSPACE_UPCOMING.map((a) => (
              <li key={a.key}>
                {a.dashboardHref
                  ? <Link href={a.dashboardHref} prefetch={false} className={s.laterLink}>{t(a.labelKey)}<span className={s.sr}>, </span><small>{t('workspace.inDashboard')}</small></Link>
                  : <span className={s.laterOff} aria-disabled="true">{t(a.labelKey)}<span className={s.sr}>, </span><small>{t('workspace.notAvailable')}</small></span>}
              </li>
            ))}
          </ul>
        </details>

        <div className={s.foot}>
          <Link href="/dashboard" prefetch={false} className={s.toDashboard}>
            <Icon name="dashboard" /><span>{t('workspace.openDashboard')}</span><span className={s.footHint}>{t('workspace.dashboardHint')}</span>
          </Link>
          <ProfileMenu fullName={fullName} email={email} />
        </div>
      </aside>
      {open && <button type="button" className={s.backdrop} aria-label={t('workspace.closeMenu')} onClick={close} tabIndex={-1} />}

      <div className={s.main}>
        <header className={s.topbar}>
          <button ref={menu} type="button" className={s.menu} aria-label={t('workspace.openMenu')} aria-controls="workspace-sidebar" aria-expanded={open} onClick={toggleMenu}>
            <Icon name="sidebar" />
          </button>
          <Link href={WORKSPACE_HOME} prefetch={false} className={s.topBrand} aria-label={t('workspace.brandLabel')}><TuGPTMark size={22} /><span>{t('workspace.name')}</span></Link>
          <Link href={WORKSPACE_HOME} prefetch={false} className={s.topNew} aria-label={t('workspace.newChat')} aria-disabled={busy ? 'true' : undefined}
            onClick={(e) => { if (busy) e.preventDefault(); }}><Icon name="plus" /></Link>
          <Link href="/dashboard" prefetch={false} className={s.topDashboard}>{t('workspace.openDashboard')}</Link>
        </header>
        <div className={s.liveRegion} role="status" aria-live="polite">
          {latest && <p className={s.decided}>{t(`workspace.approvals.notify.${latest.status === 'approved' ? 'approved' : latest.status === 'rejected' ? 'rejected' : 'closed'}`, { capability: latest.capability })}{' '}<Link href={WORKSPACE_APPROVALS_SECTION.href} prefetch={false}>{t('workspace.approvals.view')}</Link></p>}
        </div>
        <main id="workspace-main" className={s.content} tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}
