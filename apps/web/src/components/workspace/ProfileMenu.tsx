'use client';

import Link from 'next/link';
import { useCallback, useId, useRef, useState } from 'react';
import { useT } from '@/i18n/provider';
import { Icon } from './icons';
import { useDismiss } from './useDismiss';
import s from './workspace.module.css';

export interface ProfileMenuProps {
  readonly fullName: string | null;
  readonly email: string | null;
}

/**
 * The signed-in person (never the organization's name, like the Dashboard) and their account
 * actions. A menu button: Enter/Space/ArrowUp open it, arrows move, Escape closes and returns focus.
 */
export function ProfileMenu({ fullName, email }: ProfileMenuProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const displayName = fullName || email || t('workspace.yourAccount');
  const initial = displayName.charAt(0).toUpperCase();

  const close = useCallback((restore: boolean) => { setOpen(false); if (restore) button.current?.focus(); }, []);
  useDismiss(open, root, close);

  const items = () => [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  function openAndFocus(which: 'first' | 'last') {
    setOpen(true);
    requestAnimationFrame(() => { const all = items(); (which === 'first' ? all[0] : all[all.length - 1])?.focus(); });
  }
  function onMenuKey(e: React.KeyboardEvent) {
    const all = items(); const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); all[(i + 1) % all.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); all[(i - 1 + all.length) % all.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); all[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); all[all.length - 1]?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  }

  return (
    <div className={s.profile} ref={root}>
      {open && (
        <div id={menuId} role="menu" aria-label={t('workspace.accountMenu')} className={s.profileMenu} onKeyDown={onMenuKey}>
          <div className={s.profileHead} role="presentation">
            <strong>{displayName}</strong>
            {email && email !== displayName && <small title={email}>{email}</small>}
          </div>
          <Link role="menuitem" href="/dashboard/settings" prefetch={false} className={s.menuItem} onClick={() => setOpen(false)}>
            <Icon name="settings" /><span>{t('workspace.accountSettings')}</span>
          </Link>
          <Link role="menuitem" href="/auth/logout" prefetch={false} className={s.menuItem}>
            <Icon name="logout" /><span>{t('shell.signOut')}</span>
          </Link>
        </div>
      )}
      <button ref={button} type="button" className={s.person} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        onClick={() => (open ? setOpen(false) : openAndFocus('first'))}
        onKeyDown={(e) => { if (e.key === 'ArrowUp') { e.preventDefault(); openAndFocus('last'); } else if (e.key === 'ArrowDown') { e.preventDefault(); openAndFocus('first'); } }}>
        <span className={s.avatar} aria-hidden="true">{initial}</span>
        <span className={s.identity}><strong>{displayName}</strong>{fullName && email && <small title={email}>{email}</small>}</span>
        <Icon name={open ? 'chevronDown' : 'chevronUp'} size={16} />
      </button>
    </div>
  );
}
