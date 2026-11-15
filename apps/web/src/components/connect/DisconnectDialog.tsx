'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { BackendGap } from '@/lib/connect-ui/contract';
import { GapNote } from './GapNote';
import s from './connect.module.css';

export interface DisconnectDialogProps {
  providerName: string;
  /** Performs the disconnect; resolves to an error message or null. Absent = no backend route. */
  onConfirm?: () => Promise<string | null>;
  gap?: BackendGap;
  onClose(): void;
  onDone?(): void;
}

/** Confirmation before revoking access. Escape or Cancel closes; focus returns to the trigger (handled by caller). */
export function DisconnectDialog({ providerName, onConfirm, gap, onClose, onDone }: DisconnectDialogProps) {
  const titleId = useId(); const descId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    cancel.current?.focus();
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
        <h2 id={titleId}>Disconnect {providerName}?</h2>
        <div id={descId}>
          <p>TuGPT will stop using this account straight away:</p>
          <ul>
            <li>Chat can no longer read {providerName} data with <kbd>@</kbd>.</li>
            <li>Everyone in your organization who uses this connection loses it.</li>
            <li>Past chats stay as they are. You can connect again at any time.</li>
          </ul>
        </div>
        {!onConfirm && gap && <GapNote gap={gap}>Disconnecting from TuGPT is not available yet. Until it is, an admin can remove TuGPT&rsquo;s access in the {providerName} account&rsquo;s own security settings.</GapNote>}
        {problem && <p className={s.error} role="alert">{problem}</p>}
        <div className={s.dialogActions}>
          <button ref={cancel} type="button" className={s.secondary} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={s.danger} onClick={() => void confirm()} disabled={!onConfirm || busy} aria-busy={busy}>
            {busy ? 'Disconnecting…' : `Disconnect ${providerName}`}
          </button>
        </div>
      </div>
    </div>
  );
}
