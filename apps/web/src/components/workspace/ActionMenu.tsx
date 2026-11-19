'use client';

import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icons';
import { useDismiss } from './useDismiss';
import u from './ui.module.css';

export interface MenuAction {
  readonly key: string;
  readonly label: string;
  readonly icon?: IconName;
  readonly danger?: boolean;
  /** A separator is drawn above this item. */
  readonly separated?: boolean;
  onSelect(): void;
}

export interface ActionMenuProps {
  /** Accessible name of the trigger, e.g. "Options for Q4 pricing notes". */
  readonly label: string;
  readonly actions: readonly MenuAction[];
  readonly className?: string;
  readonly icon?: IconName;
  readonly disabled?: boolean;
}

/**
 * A "⋯" menu button. The menu is portalled and fixed-positioned next to the trigger, so it is
 * never clipped by a scrolling sidebar; it flips above the trigger near the bottom of the screen.
 * Keyboard: Enter/Space/ArrowDown open on the first item, ArrowUp on the last; arrows, Home and End
 * move; Escape or Tab closes, Escape returns focus to the trigger.
 */
export function ActionMenu({ label, actions, className, icon = 'more', disabled = false }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const want = useRef<'first' | 'last'>('first');

  const close = useCallback((restore: boolean) => { setOpen(false); setPos(null); if (restore) trigger.current?.focus(); }, []);
  useDismiss(open, root, close);

  useLayoutEffect(() => {
    if (!open || !pos) return;
    const items = root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (!items?.length) return;
    (want.current === 'first' ? items[0] : items[items.length - 1]).focus();
  }, [open, pos]);

  /** Position is measured in the event that opens the menu (no state set inside effects). */
  function show(which: 'first' | 'last') {
    want.current = which;
    const r = trigger.current?.getBoundingClientRect();
    if (r) {
      const width = 220, height = actions.length * 40 + 12;
      const below = r.bottom + 4 + height <= window.innerHeight;
      setPos({ top: below ? r.bottom + 4 : Math.max(8, r.top - height - 4), left: Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8) });
    }
    setOpen(true);
  }
  function onKey(e: React.KeyboardEvent) {
    const items = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
    else if (e.key === 'Tab') close(false);
  }

  return (
    <>
      <button ref={trigger} type="button" className={className ?? u.iconButton} aria-label={label} title={label} disabled={disabled}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : show('first'))}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); show('first'); } else if (e.key === 'ArrowUp') { e.preventDefault(); show('last'); } }}>
        <Icon name={icon} size={16} />
      </button>
      {open && createPortal(
        <div ref={root} id={menuId} role="menu" aria-label={label} className={u.menu} onKeyDown={onKey}
          style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: 220 }}>
          {actions.map((a) => (
            <div key={a.key} role="none">
              {a.separated && <div className={u.menuSep} role="separator" />}
              <button type="button" role="menuitem" tabIndex={-1} className={`${u.menuItem} ${a.danger ? u.menuDanger : ''}`}
                onClick={() => { close(true); a.onSelect(); }}>
                {a.icon && <Icon name={a.icon} size={16} />}<span>{a.label}</span>
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
