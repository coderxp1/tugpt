'use client';

import { useEffect, useId, useRef, useState } from 'react';
import s from './connect.module.css';

export interface ConfirmDialogProps {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  busyLabel: string;
  /** Performs the action; resolves to an error message or null. Absent = action not available. */
  onConfirm?: () => Promise<string | null>;
  /** Extra content shown when onConfirm is absent (why it cannot run). */
  unavailable?: React.ReactNode;
  onClose(): void;
  onDone?(): void;
}

/** Destructive-action confirmation. Focus starts on Cancel; Escape and backdrop close unless busy; the caller restores focus. */
export function ConfirmDialog({ title, children, confirmLabel, busyLabel, onConfirm, unavailable, onClose, onDone }: ConfirmDialogProps) {
  const titleId = useId(); const descId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function confirm() {
    if (!onConfirm) return;
    setBusy(true); setProblem(null);
    const err = await onConfirm();
    setBusy(false);
    if (err) setProblem(err); else onDone?.();
  }

  return (
    <div className={s.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className={s.dialog} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId}>
        <h2 id={titleId}>{title}</h2>
        <div id={descId}>{children}</div>
        {!onConfirm && unavailable}
        {problem && <p className={s.error} role="alert">{problem}</p>}
        <div className={s.dialogActions}>
          <button ref={cancel} type="button" className={s.secondary} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={s.danger} onClick={() => void confirm()} disabled={!onConfirm || busy} aria-busy={busy}>
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
