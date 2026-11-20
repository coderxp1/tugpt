'use client';

import { ToolState, type ToolRunState } from './ToolState';
import { useEffect, useId, useReducer, useState } from 'react';
import { useT } from '@/i18n/provider';
import {
  approvalReducer, checkApproval, displayArguments, failureText, INITIAL_APPROVAL, permissionText, requestApproval, revokeApproval, TTL_OPTIONS, ttlLabel,
  type PendingApproval,
} from '@/lib/chat/approval';
import { toolProblem } from '@/lib/connect-ui/chat-errors';
import s from './chat.module.css';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApprovalCardProps {
  approval: PendingApproval;
  /** Owner or admin of the active organization (the backend enforces this again). */
  canApprove: boolean;
  /** Another answer is streaming; running now would interleave two turns. */
  busy: boolean;
  /** Runs the approved call once through the chat route and reports the tool result. */
  /** code REQUEST_REFUSED: the server refused before running; message is the server's reason. */
  onRun(approval: PendingApproval): Promise<{ ok: boolean; code?: string; message?: string }>;
  fetchFn?: FetchFn;
  now?: () => number;
}

function mmss(ms: number): string {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * Approval card for one MCP call that changes something. States: pending ->
 * approving -> approved -> running -> done, plus rejected, revoked, expired
 * and failed. A failed or unconfirmed approval request never enables Run.
 */
export function ApprovalCard({ approval, canApprove, busy, onRun, fetchFn = (i, init) => fetch(i, init), now = Date.now }: ApprovalCardProps) {
  const t = useT();
  const [state, dispatch] = useReducer(approvalReducer, INITIAL_APPROVAL);
  const [ttl, setTtl] = useState<number>(TTL_OPTIONS[0].seconds);
  const [checked, setChecked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [clock, setClock] = useState(() => now());
  const id = useId();
  const perm = permissionText(approval.permissionClass, t);
  const args = displayArguments(approval.arguments);
  const expiresAt = state.kind === 'approved' || state.kind === 'running' || state.kind === 'revoking' ? state.expiresAt : null;

  // Countdown; the approval is consumed or refused by the database either way, this only keeps the card honest.
  useEffect(() => {
    if (state.kind !== 'approved' || state.expiresAt === null) return;
    const deadline = state.expiresAt;
    const t = setInterval(() => {
      const n = now();
      setClock(n);
      if (n >= deadline) dispatch({ type: 'expire' });
    }, 1000);
    return () => clearInterval(t);
  }, [state, now]);

  async function approve() {
    if (!checked || !canApprove) return;
    setNotice(null);
    dispatch({ type: 'approve' });
    const r = await requestApproval(approval, ttl, fetchFn);
    if (!r.ok) { dispatch({ type: 'approve_failed', reason: r.reason, ...(r.code ? { code: r.code } : {}) }); return; }
    // Trust the database, not the response alone: the approval must now exist.
    const v = await checkApproval(approval, fetchFn);
    if (!v.ok || !v.value.approved) { dispatch({ type: 'approve_failed', reason: 'not_recorded' }); return; }
    setClock(now());
    dispatch({ type: 'approved', id: r.value.id, expiresAt: r.value.expiresAt });
  }

  async function checkAgain() {
    setNotice(null);
    dispatch({ type: 'approve' });
    const v = await checkApproval(approval, fetchFn);
    if (!v.ok) { dispatch({ type: 'approve_failed', reason: v.reason }); return; }
    if (!v.value.approved) { dispatch({ type: 'approve_failed', reason: 'forbidden' }); setNotice(t('chat.ap.n.noneYet')); return; }
    dispatch({ type: 'approved', id: null, expiresAt: null });
  }

  async function revoke(then: 'revoked' | 'rejected') {
    setNotice(null);
    dispatch({ type: 'revoke', then });
    const id = state.kind === 'approved' || state.kind === 'running' || state.kind === 'revoking' ? state.id : null;
    if (id === null) { dispatch({ type: 'revoke_failed' }); return; }
    const r = await revokeApproval(id, fetchFn);
    if (!r.ok) {
      dispatch({ type: 'revoke_failed' });
      setNotice(t('chat.ap.n.revokeFailed', { reason: failureText(r.reason, canApprove, t) }));
      return;
    }
    if (!r.value.revoked) setNotice(t('chat.ap.n.nothingToRevoke'));
    dispatch({ type: 'revoke_done' });
  }

  async function run() {
    setNotice(null);
    dispatch({ type: 'run' });
    try {
      const r = await onRun(approval);
      if (!r.ok && r.code === 'REQUEST_REFUSED') {
        dispatch({ type: 'run_refused' });
        setNotice(t(canApprove ? 'chat.ap.n.refusedRevocable' : 'chat.ap.n.refused', { reason: r.message ?? t('chat.ap.n.serverRefused') }));
        return;
      }
      dispatch({ type: 'run_done', ok: r.ok, ...(r.code ? { code: r.code } : {}) });
    } catch { dispatch({ type: 'run_done', ok: false, code: 'INTERRUPTED' }); }
  }

  const statusText = (() => {
    switch (state.kind) {
      case 'pending': return canApprove ? t('chat.ap.s.pendingYou') : t('chat.ap.s.pendingOther');
      case 'approving': return t('chat.ap.s.approving');
      case 'approved': return state.expiresAt === null ? t('chat.ap.s.approved') : t('chat.ap.s.approvedExp', { time: mmss(state.expiresAt - clock) });
      case 'running': return t('chat.ap.s.running');
      case 'done':
        if (state.ok) return t('chat.ap.s.done');
        if (state.code === 'APPROVAL_REQUIRED') return t('chat.ap.s.dbRefused');
        return t('chat.ap.s.notCompleted', { reason: toolProblem(state.code, t).text });
      case 'rejected': return t('chat.ap.s.rejected');
      case 'revoking': return t('chat.ap.s.revoking');
      case 'revoked': return t('chat.ap.s.revoked');
      case 'expired': return t('chat.ap.s.expired');
      case 'failed': return failureText(state.reason, canApprove, t);
    }
  })();

  const pill: ToolRunState = state.kind === 'pending' || state.kind === 'failed' || state.kind === 'approving' ? 'awaiting'
    : state.kind === 'running' || state.kind === 'approved' || state.kind === 'revoking' ? 'running'
    : state.kind === 'done' ? (state.ok ? 'completed' : 'failed') : 'not_run';
  const decide = state.kind === 'pending' || state.kind === 'failed';
  const closed = state.kind === 'done' || state.kind === 'rejected' || state.kind === 'revoked' || state.kind === 'expired';

  return (
    <section className={`${s.approval} ${closed ? s.approvalClosed : ''}`} aria-labelledby={`${id}-t`} data-state={state.kind}>
      <header className={s.approvalHead}>
        <span className={`${s.permBadge} ${approval.permissionClass === 'write' ? '' : s.permDanger}`}>{perm.label}</span>
        <h2 id={`${id}-t`}>{t('chat.ap.title')}</h2>
        <ToolState state={pill} />
      </header>
      <p className={s.approvalWhat}>
        {(() => { const [a, rest] = t('chat.ap.what', { tool: '\u0000', endpoint: '\u0001' }).split('\u0000'); const [b, c] = rest.split('\u0001'); return <>{a}<code>{approval.toolName}</code>{b}<strong>{approval.endpointName}</strong>{c}</>; })()} {perm.effect}
      </p>
      <dl className={s.approvalFacts}>
        <dt>{t('chat.ap.tool')}</dt><dd><code>{approval.toolName}</code>{approval.toolDescription && <> — {approval.toolDescription}</>}</dd>
        <dt>{t('chat.ap.endpoint')}</dt><dd>{approval.endpointName} <span className={s.host}>({approval.endpointHost})</span></dd>
      </dl>
      <h3 className={s.argsTitle}>{t('chat.ap.args')}</h3>
      {args.lines.length === 0 ? <p className={s.muted}>{t('chat.ap.noArgs')}</p> : (
        <table className={s.args}>
          <caption className={s.sr}>{t('chat.ap.argsCaption')}</caption>
          <tbody>{args.lines.map((l) => (
            <tr key={l.path}><th scope="row">{l.path}</th>
              <td>{l.redacted ? <span className={s.redacted}>{t('chat.ap.hidden')}</span> : <span className={s.argValue}>{l.value}</span>}{l.truncated && <span className={s.muted}>{t('chat.ap.shortened')}</span>}</td></tr>
          ))}</tbody>
        </table>
      )}
      {args.omitted > 0 && <p className={s.muted}>{args.omitted === 1 ? t('chat.ap.omittedOne') : t('chat.ap.omittedMany', { count: args.omitted })}</p>}
      <p className={s.fine}>{t('chat.ap.fine')} <code>{approval.argumentsSha256.slice(0, 12)}</code></p>

      <p className={s.approvalStatus} role="status" aria-live="polite">{statusText}</p>
      {notice && <p className={s.approvalNotice}>{notice}</p>}

      {decide && canApprove && (
        <div className={s.approvalForm}>
          <fieldset>
            <legend>{t('chat.ap.validFor')}</legend>
            {TTL_OPTIONS.map((o) => (
              <label key={o.seconds}><input type="radio" name={`${id}-ttl`} value={o.seconds} checked={ttl === o.seconds} onChange={() => setTtl(o.seconds)} /> {ttlLabel(o.seconds, t)}</label>
            ))}
          </fieldset>
          <label className={s.confirm}><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {t('chat.ap.confirm')}</label>
          <div className={s.approvalActions}>
            <button type="button" className={s.approve} onClick={() => void approve()} disabled={!checked} aria-describedby={`${id}-t`}>{t('chat.ap.approve')}</button>
            <button type="button" className={s.reject} onClick={() => dispatch({ type: 'reject' })}>{t('chat.ap.reject')}</button>
          </div>
        </div>
      )}
      {decide && !canApprove && (
        <div className={s.approvalForm}>
          <p className={s.muted}>{t('chat.ap.onlyAdmins')}</p>
          <div className={s.approvalActions}>
            <button type="button" className={s.reject} onClick={() => void checkAgain()}>{t('chat.ap.checkAgain')}</button>
            <button type="button" className={s.reject} onClick={() => dispatch({ type: 'reject' })}>{t('chat.ap.dismiss')}</button>
          </div>
        </div>
      )}
      {state.kind === 'approved' && (
        <div className={s.approvalActions}>
          <button type="button" className={s.approve} onClick={() => void run()} disabled={busy}>{t('chat.ap.runNow')}</button>
          {canApprove && <button type="button" className={s.reject} onClick={() => void revoke('revoked')}>{t('chat.ap.revoke')}</button>}
          {busy && <span className={s.muted}>{t('chat.ap.waitBusy')}</span>}
        </div>
      )}
      {(state.kind === 'approving' || state.kind === 'running' || state.kind === 'revoking') && <span className={s.sr}>{t('chat.ap.working')}</span>}
      {expiresAt !== null && state.kind === 'running' && <span className={s.sr}>{t('chat.ap.expiry', { at: new Date(expiresAt).toISOString() })}</span>}
    </section>
  );
}
