'use client';

import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '@/i18n/provider';
import { Icon } from './icons';
import u from './ui.module.css';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  readonly title: string;
  readonly description?: string;
  /** `alert` for confirmations of consequential actions (delete, approve): role="alertdialog". */
  readonly tone?: 'default' | 'alert';
  readonly wide?: boolean;
  onClose(): void;
  readonly children: React.ReactNode;
  /** The action row. */
  readonly footer?: React.ReactNode;
}

/**
 * A modal dialog: rendered at the end of <body> (the sidebar drawer is transformed and clipped),
 * labelled by its title, focus moves in (first field, else first control), Tab is trapped, Escape
 * closes, and focus returns to whatever opened it. The page behind is inert to the pointer.
 */
export function Dialog({ title, description, tone = 'default', wide = false, onClose, children, footer }: DialogProps) {
  const t = useT();
  const titleId = useId();
  const descId = useId();
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => {
      const root = box.current; if (!root) return;
      const field = root.querySelector<HTMLElement>('[data-autofocus],input:not([type="hidden"]):not([disabled]),textarea,select');
      (field ?? root.querySelector<HTMLElement>(FOCUSABLE) ?? root).focus();
    });
    function key(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current(); return; }
      if (e.key !== 'Tab' || !box.current) return;
      const nodes = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', key, true);
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', key, true);
      document.body.style.overflow = old;
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  return createPortal(
    <div className={u.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className={`${u.dialog} ${wide ? u.dialogWide : ''}`} role={tone === 'alert' ? 'alertdialog' : 'dialog'} aria-modal="true"
        aria-labelledby={titleId} aria-describedby={description ? descId : undefined} tabIndex={-1}>
        <div className={u.dialogHead}>
          <h2 id={titleId}>{title}</h2>
          <button type="button" className={u.iconButton} onClick={onClose} aria-label={t('workspace.dialog.close')}><Icon name="close" size={16} /></button>
        </div>
        {description && <p id={descId} className={u.dialogDesc}>{description}</p>}
        <div className={u.dialogBody}>{children}</div>
        {footer && <div className={u.dialogFoot}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
