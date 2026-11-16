'use client';

import { useEffect, useId, useReducer, useState } from 'react';
import {
  approvalReducer, checkApproval, displayArguments, failureText, INITIAL_APPROVAL, PERMISSION_TEXT, requestApproval, revokeApproval, TTL_OPTIONS,
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
  const [state, dispatch] = useReducer(approvalReducer, INITIAL_APPROVAL);
  const [ttl, setTtl] = useState<number>(TTL_OPTIONS[0].seconds);
  const [checked, setChecked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [clock, setClock] = useState(() => now());
  const id = useId();
  const perm = PERMISSION_TEXT[approval.permissionClass];
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
    const started = now();
    const r = await requestApproval(approval, ttl, fetchFn);
    if (!r.ok) { dispatch({ type: 'approve_failed', reason: r.reason, ...(r.code ? { code: r.code } : {}) }); return; }
    // Trust the database, not the response alone: the approval must now exist.
    const v = await checkApproval(approval, fetchFn);
    if (!v.ok || !v.value.approved) { dispatch({ type: 'approve_failed', reason: 'not_recorded' }); return; }
    setClock(now());
    dispatch({ type: 'approved', expiresAt: started + ttl * 1000 });
  }

  async function checkAgain() {
    setNotice(null);
    dispatch({ type: 'approve' });
    const v = await checkApproval(approval, fetchFn);
    if (!v.ok) { dispatch({ type: 'approve_failed', reason: v.reason }); return; }
    if (!v.value.approved) { dispatch({ type: 'approve_failed', reason: 'forbidden' }); setNotice('No approval for this exact call exists yet.'); return; }
    dispatch({ type: 'approved', expiresAt: null });
  }

  async function revoke(then: 'revoked' | 'rejected') {
    setNotice(null);
    dispatch({ type: 'revoke', then });
    const r = await revokeApproval(approval, fetchFn);
    if (!r.ok) {
      dispatch({ type: 'revoke_failed' });
      setNotice(`The approval could not be revoked (${failureText(r.reason, canApprove)}) It stays valid until it expires or is used.`);
      return;
    }
    if (!r.value.revoked) setNotice('There was no unused approval left to revoke (it was already used, revoked or had expired).');
    dispatch({ type: 'revoke_done' });
  }

  async function run() {
    setNotice(null);
    dispatch({ type: 'run' });
    try {
      const r = await onRun(approval);
      if (!r.ok && r.code === 'REQUEST_REFUSED') {
        dispatch({ type: 'run_refused' });
        setNotice(`Not run: ${r.message ?? 'the server refused the call'}. The approval was not used and stays valid until it expires${canApprove ? ' or you revoke it' : ''}.`);
        return;
      }
      dispatch({ type: 'run_done', ok: r.ok, ...(r.code ? { code: r.code } : {}) });
    } catch { dispatch({ type: 'run_done', ok: false, code: 'INTERRUPTED' }); }
  }

  const statusText = (() => {
    switch (state.kind) {
      case 'pending': return canApprove ? 'Waiting for your decision. Nothing has run.' : 'Waiting for an owner or admin. Nothing has run.';
      case 'approving': return 'Recording the approval…';
      case 'approved': return state.expiresAt === null ? 'Approved for one run.' : `Approved for one run. Expires in ${mmss(state.expiresAt - clock)}.`;
      case 'running': return 'Running the approved call…';
      case 'done':
        if (state.ok) return 'Done. The call ran once; the answer is shown below.';
        if (state.code === 'APPROVAL_REQUIRED') return 'Not run: the database did not accept the approval (expired, revoked, already used, or the call changed).';
        return `Not completed: ${toolProblem(state.code).text}`;
      case 'rejected': return 'Rejected. Nothing was run.';
      case 'revoking': return 'Revoking the approval…';
      case 'revoked': return 'Approval revoked. Nothing was run.';
      case 'expired': return 'The approval expired before it was used. Nothing was run.';
      case 'failed': return failureText(state.reason, canApprove);
    }
  })();

  const decide = state.kind === 'pending' || state.kind === 'failed';
  const closed = state.kind === 'done' || state.kind === 'rejected' || state.kind === 'revoked' || state.kind === 'expired';

  return (
    <section className={`${s.approval} ${closed ? s.approvalClosed : ''}`} aria-labelledby={`${id}-t`} data-state={state.kind}>
      <header className={s.approvalHead}>
        <span className={`${s.permBadge} ${approval.permissionClass === 'write' ? '' : s.permDanger}`}>{perm.label}</span>
        <h2 id={`${id}-t`}>Approve this action?</h2>
      </header>
      <p className={s.approvalWhat}>
        TuGPT wants to run <code>{approval.toolName}</code> on <strong>{approval.endpointName}</strong>. {perm.effect}
      </p>
      <dl className={s.approvalFacts}>
        <dt>Tool</dt><dd><code>{approval.toolName}</code>{approval.toolDescription && <> — {approval.toolDescription}</>}</dd>
        <dt>Endpoint</dt><dd>{approval.endpointName} <span className={s.host}>({approval.endpointHost})</span></dd>
      </dl>
      <h3 className={s.argsTitle}>Arguments</h3>
      {args.lines.length === 0 ? <p className={s.muted}>No arguments.</p> : (
        <table className={s.args}>
          <caption className={s.sr}>Arguments of this call. Hidden values are secrets and are not shown.</caption>
          <tbody>{args.lines.map((l) => (
            <tr key={l.path}><th scope="row">{l.path}</th>
              <td>{l.redacted ? <span className={s.redacted}>Hidden</span> : <span className={s.argValue}>{l.value}</span>}{l.truncated && <span className={s.muted}> (shortened)</span>}</td></tr>
          ))}</tbody>
        </table>
      )}
      {args.omitted > 0 && <p className={s.muted}>{args.omitted} more value{args.omitted === 1 ? '' : 's'} not shown.</p>}
      <p className={s.fine}>An approval covers this exact call with these arguments, once. Reference <code>{approval.argumentsSha256.slice(0, 12)}</code></p>

      <p className={s.approvalStatus} role="status" aria-live="polite">{statusText}</p>
      {notice && <p className={s.approvalNotice}>{notice}</p>}

      {decide && canApprove && (
        <div className={s.approvalForm}>
          <fieldset>
            <legend>Approval valid for</legend>
            {TTL_OPTIONS.map((o) => (
              <label key={o.seconds}><input type="radio" name={`${id}-ttl`} value={o.seconds} checked={ttl === o.seconds} onChange={() => setTtl(o.seconds)} /> {o.label}</label>
            ))}
          </fieldset>
          <label className={s.confirm}><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> I checked the endpoint, tool and arguments and want this call to run once.</label>
          <div className={s.approvalActions}>
            <button type="button" className={s.approve} onClick={() => void approve()} disabled={!checked} aria-describedby={`${id}-t`}>Approve</button>
            <button type="button" className={s.reject} onClick={() => dispatch({ type: 'reject' })}>Reject</button>
          </div>
        </div>
      )}
      {decide && !canApprove && (
        <div className={s.approvalForm}>
          <p className={s.muted}>Only an owner or admin of this organization can approve actions that change data. Chat cannot send them an approval request yet, so ask them directly. Nothing was changed.</p>
          <div className={s.approvalActions}>
            <button type="button" className={s.reject} onClick={() => void checkAgain()}>Check again</button>
            <button type="button" className={s.reject} onClick={() => dispatch({ type: 'reject' })}>Dismiss</button>
          </div>
        </div>
      )}
      {state.kind === 'approved' && (
        <div className={s.approvalActions}>
          <button type="button" className={s.approve} onClick={() => void run()} disabled={busy}>Run now</button>
          {canApprove && <button type="button" className={s.reject} onClick={() => void revoke('revoked')}>Revoke approval</button>}
          {busy && <span className={s.muted}>Wait until the current answer finishes.</span>}
        </div>
      )}
      {(state.kind === 'approving' || state.kind === 'running' || state.kind === 'revoking') && <span className={s.sr}>Working</span>}
      {expiresAt !== null && state.kind === 'running' && <span className={s.sr}>Approval expiry {new Date(expiresAt).toISOString()}</span>}
    </section>
  );
}
