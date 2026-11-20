'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { useT } from '@/i18n/provider';
import { Icon } from '@/components/workspace/icons';
import { useDismiss } from '@/components/workspace/useDismiss';
import type { PublicModel } from './types';
import s from './chat.module.css';

export interface ModelMenuProps {
  readonly models: readonly PublicModel[];
  readonly value: string;
  readonly disabled: boolean;
  onChange(key: string): void;
}

/**
 * The model picker in the composer: a button that opens a listbox (WAI-ARIA "select-only combobox"
 * pattern, simplified to button + listbox). Only models whose endpoint is configured on the server
 * are listed (lib/chat/models.ts), each with what matters for the choice: private or hosted, and
 * whether it may use apps. Switching model never changes the layout; the next message uses it.
 */
export function ModelMenu({ models, value, disabled, onChange }: ModelMenuProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const current = models.find((m) => m.key === value) ?? null;

  const close = useCallback((restore: boolean) => { setOpen(false); if (restore) button.current?.focus(); }, []);
  useDismiss(open, root, close);

  function show() {
    if (disabled || models.length === 0) return;
    setIndex(Math.max(0, models.findIndex((m) => m.key === value)));
    setOpen(true);
    requestAnimationFrame(() => list.current?.focus());
  }
  function pick(i: number) { const m = models[i]; if (m && m.available !== false) onChange(m.key); close(true); }
  function onListKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => (i + 1) % models.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => (i - 1 + models.length) % models.length); }
    else if (e.key === 'Home') { e.preventDefault(); setIndex(0); }
    else if (e.key === 'End') { e.preventDefault(); setIndex(models.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(index); }
    else if (e.key === 'Tab') setOpen(false);
  }

  return (
    <div className={s.menuRoot} ref={root}>
      <button ref={button} type="button" className={s.tool} disabled={disabled || models.length === 0}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined}
        aria-label={t('workspace.model.button', { model: current?.label ?? t('workspace.model.none') })}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); show(); } }}>

        <span className={s.toolText}>{current?.label ?? t('workspace.model.none')}</span>
        <Icon name="chevronDown" size={15} />
      </button>
      {open && (
        <ul ref={list} id={`${id}-list`} role="listbox" tabIndex={-1} aria-label={t('workspace.model.choose')}
          aria-activedescendant={`${id}-${index}`} className={`${s.popover} ${s.modelList}`} onKeyDown={onListKey}>
          {models.map((m, i) => (
            <li key={m.key} id={`${id}-${i}`} role="option" aria-selected={m.key === value} aria-disabled={m.available === false}
              className={`${s.modelOption} ${i === index ? s.modelActive : ''}`}
              onMouseEnter={() => setIndex(i)} onMouseDown={(e) => { e.preventDefault(); pick(i); }}>
              <span className={s.modelName}>{m.label}
                {m.available === false && <em>{t('workspace.capability.unavailable')}</em>}
                {m.toolCalling && <em className={s.badgeTools}>{t('workspace.model.apps')}</em>}
              </span>

              {m.key === value && <span className={s.modelCheck}><Icon name="check" size={16} /></span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
