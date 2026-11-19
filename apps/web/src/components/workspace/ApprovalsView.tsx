'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useT } from '@/i18n/provider';
import type { MessageKey } from '@/i18n/types';
import type { ApprovalAction, ApprovalRecord, ApprovalStatus } from '@/lib/workspace-data/contracts';
import { hasArray, messageKeyFor, workspaceApi } from '@/lib/workspace/service';
import { threadHref } from '@/lib/workspace/routes';
import { Dialog } from './Dialog';
import { Icon } from './icons';
import { Badge, EmptyState, LoadingRows, ServiceNotice, When, type Tone } from './states';
import { useLoad } from './useLoad';
import s from './pages.module.css';
import a from './approvals.module.css';
import u from './ui.module.css';

export interface ApprovalsViewProps {
  /** Owner/admin: may see the organization's requests and approve/reject/revoke (the API re-checks). */
  readonly canDecide: boolean;
  readonly userId: string | null;
}

const STATUSES: readonly ApprovalStatus[] = ['pending', 'approved', 'rejected', 'cancelled', 'expired', 'used', 'revoked'];
const TONE: Record<ApprovalStatus, Tone> = { pending: 'warn', approved: 'good', used: 'info', rejected: 'bad', revoked: 'bad', cancelled: 'neutral', expired: 'neutral' };
const TTL_MINUTES = [5, 15, 30, 60] as const;
const NOTE_MAX = 500;
type Page = { approvals: readonly ApprovalRecord[]; nextCursor: string | null };
type Act = { kind: 'approve' | 'reject' | 'cancel' | 'revoke'; record: ApprovalRecord };

/**
 * Approval history: every request to run a sensitive tool call, who asked, who decided, and what
 * the call would do (as a redacted preview; raw arguments are never stored). Members see their own
 * requests and can cancel pending ones; owners and admins see the organization's and decide.
 * Every decision is confirmed in a dialog that repeats exactly what is being approved.
 */
export function ApprovalsView({ canDecide, userId }: ApprovalsViewProps) {
  const t = useT();
  const [scope, setScope] = useState<'mine' | 'org'>(canDecide ? 'org' : 'mine');
  const [status, setStatus] = useState<ApprovalStatus | 'all'>(canDecide ? 'pending' : 'all');
  const [more, setMore] = useState<{ key: string; items: readonly ApprovalRecord[]; cursor: string | null; loading: boolean; failed: boolean } | null>(null);
  const [act, setAct] = useState<Act | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const scopeId = useId();
  const statusId = useId();
  const key = `${scope}:${status}`;
  const { load, reload } = useLoad<Page>(key, () => workspaceApi().listApprovals({ scope, status: status === 'all' ? undefined : status, limit: 25 }), (v) => hasArray(v, 'approvals'));

  const extra = more && more.key === key ? more : null;
  const items = load.state === 'ready' ? [...load.value.approvals, ...(extra?.items ?? [])] : [];
  const cursor = extra ? extra.cursor : load.state === 'ready' ? load.value.nextCursor : null;

  async function loadMore() {
    if (!cursor) return;
    setMore({ key, items: extra?.items ?? [], cursor, loading: true, failed: false });
    const r = await workspaceApi().listApprovals({ scope, status: status === 'all' ? undefined : status, limit: 25, before: cursor });
    if (r.ok && hasArray(r.value, 'approvals')) setMore({ key, items: [...(extra?.items ?? []), ...r.value.approvals], cursor: r.value.nextCursor, loading: false, failed: false });
    else setMore({ key, items: extra?.items ?? [], cursor, loading: false, failed: true });
  }
  function refresh(text: string) { setMore(null); setNotice(text); reload(); }

  return (
    <div className={s.page}>
      <div className={s.inner}>
        <header className={s.head}>
          <p className={s.eyebrow}>{t('workspace.area.approvals')}</p>
          <h1>{t('workspace.approvals.title')}</h1>
          <p>{canDecide ? t('workspace.approvals.introAdmin') : t('workspace.approvals.introMember')}</p>
        </header>

        <div className={a.filters}>
          {canDecide && (
            <div className={a.segment} role="radiogroup" aria-labelledby={scopeId}>
              <span id={scopeId} className={u.sr}>{t('workspace.approvals.scope')}</span>
              {(['org', 'mine'] as const).map((v) => (
                <button key={v} type="button" role="radio" aria-checked={scope === v} className={scope === v ? a.segOn : a.seg} onClick={() => setScope(v)}>
                  {t(v === 'org' ? 'workspace.approvals.scopeOrg' : 'workspace.approvals.scopeMine')}
                </button>
              ))}
            </div>
          )}
          <label className={a.select} htmlFor={statusId}>
            <span>{t('workspace.approvals.status')}</span>
            <select id={statusId} value={status} onChange={(e) => setStatus(e.target.value as ApprovalStatus | 'all')}>
              <option value="all">{t('workspace.approvals.statusAll')}</option>
              {STATUSES.map((st) => <option key={st} value={st}>{t(`workspace.approvals.st.${st}`)}</option>)}
            </select>
          </label>
          <button type="button" className={u.button} onClick={() => { setMore(null); reload(); }}><Icon name="refresh" size={15} />{t('workspace.refresh')}</button>
        </div>

        <div role="status" aria-live="polite" className={a.live}>{notice && <p className={a.toast}>{notice}</p>}</div>

        {load.state === 'loading' && <LoadingRows label={t('workspace.approvals.loading')} rows={3} tall />}
        {load.state === 'error' && <ServiceNotice problem={load.problem} failure={load.failure} feature={t('workspace.area.approvals')} detail={t('workspace.approvals.unavailableDetail')} onRetry={reload} />}
        {load.state === 'ready' && items.length === 0 && (
          <EmptyState icon="approvals" title={status === 'pending' ? t('workspace.approvals.emptyPending') : t('workspace.approvals.empty')} body={t('workspace.approvals.emptyBody')} />
        )}
        {items.length > 0 && (
          <ul className={a.list}>
            {items.map((r) => (
              <ApprovalItem key={r.id} record={r} canDecide={canDecide} mine={!!userId && r.requestedBy.id === userId} onAct={(kind) => { setNotice(null); setAct({ kind, record: r }); }} />
            ))}
          </ul>
        )}
        {cursor && load.state === 'ready' && (
          <div className={a.more}>
            {extra?.failed && <p className={u.fieldError} role="alert">{t('workspace.approvals.moreFailed')}</p>}
            <button type="button" className={u.button} onClick={() => void loadMore()} disabled={extra?.loading}>{extra?.loading ? t('workspace.loading') : t('workspace.loadMore')}</button>
          </div>
        )}
      </div>
      {act && <DecideDialog act={act} onClose={() => setAct(null)} onDone={(text) => { setAct(null); refresh(text); }} />}
    </div>
  );
}

function label(r: ApprovalRecord) { return r.endpointName ? `${r.endpointName} · ${r.capability}` : r.capability; }

function ApprovalItem({ record: r, canDecide, mine, onAct }: { record: ApprovalRecord; canDecide: boolean; mine: boolean; onAct(kind: Act['kind']): void }) {
  const t = useT();
  const pending = r.status === 'pending';
  const revocable = r.status === 'approved' && !r.usedAt && !r.revokedAt;
  return (
    <li className={a.item}>
      <div className={a.itemHead}>
        <span className={a.mark} aria-hidden="true"><Icon name="shield" size={18} /></span>
        <div className={a.what}>
          <h2>{label(r)}</h2>
          <p className={a.meta}>
            <span>{t('workspace.approvals.requestedBy', { name: r.requestedBy.name ?? t('workspace.approvals.someone') })}</span>
            <span aria-hidden="true">·</span><When iso={r.createdAt} />
            {r.threadId && <><span aria-hidden="true">·</span><Link href={threadHref(r.threadId)} prefetch={false}>{t('workspace.approvals.openChat')}</Link></>}
          </p>
        </div>
        <div className={a.badges}>
          {r.permissionClass && <Badge tone={r.permissionClass === 'write' ? 'info' : 'bad'}>{t(`workspace.approvals.class.${r.permissionClass}`)}</Badge>}
          <Badge tone={TONE[r.status]}>{t(`workspace.approvals.st.${r.status}`)}</Badge>
        </div>
      </div>

      {r.reason && <p className={a.reason}><strong>{t('workspace.approvals.reason')}</strong> {r.reason}</p>}
      <details className={a.details}>
        <summary>{t('workspace.approvals.details')}</summary>
        <Preview record={r} />
        <dl className={a.facts}>
          <div><dt>{t('workspace.approvals.source')}</dt><dd>{t(r.source === 'direct' ? 'workspace.approvals.sourceDirect' : 'workspace.approvals.sourceRequest')}</dd></div>
          <div><dt>{t('workspace.approvals.fingerprint')}</dt><dd><code title={r.argumentsSha256}>{r.argumentsSha256.slice(0, 12)}…</code></dd></div>
          {pending && <div><dt>{t('workspace.approvals.expires')}</dt><dd><When iso={r.expiresAt} /></dd></div>}
          {r.decidedBy && <div><dt>{t('workspace.approvals.decidedBy')}</dt><dd>{r.decidedBy.name ?? t('workspace.approvals.someone')} · <When iso={r.decidedAt} /></dd></div>}
          {r.decisionNote && <div><dt>{t('workspace.approvals.note')}</dt><dd>{r.decisionNote}</dd></div>}
          {r.approvalExpiresAt && r.status === 'approved' && <div><dt>{t('workspace.approvals.validUntil')}</dt><dd><When iso={r.approvalExpiresAt} /></dd></div>}
          {r.usedAt && <div><dt>{t('workspace.approvals.usedAt')}</dt><dd><When iso={r.usedAt} /></dd></div>}
        </dl>
      </details>

      {(pending || revocable) && (canDecide || mine) && (
        <div className={a.actions}>
          {pending && canDecide && <button type="button" className={u.buttonPrimary} onClick={() => onAct('approve')}><Icon name="check" size={15} />{t('workspace.approvals.approve')}</button>}
          {pending && canDecide && <button type="button" className={u.button} onClick={() => onAct('reject')}>{t('workspace.approvals.reject')}</button>}
          {pending && mine && <button type="button" className={u.buttonGhost} onClick={() => onAct('cancel')}>{t('workspace.approvals.cancelRequest')}</button>}
          {revocable && canDecide && <button type="button" className={u.button} onClick={() => onAct('revoke')}>{t('workspace.approvals.revoke')}</button>}
        </div>
      )}
    </li>
  );
}

function Preview({ record: r }: { record: ApprovalRecord }) {
  const t = useT();
  if (!r.argumentsPreview.length) return <p className={u.help}>{t('workspace.approvals.noArguments')}</p>;
  return (
    <div className={a.preview}>
      <p className={u.help}>{t('workspace.approvals.previewHelp')}</p>
      <table>
        <caption className={u.sr}>{t('workspace.approvals.previewCaption', { capability: label(r) })}</caption>
        <thead><tr><th scope="col">{t('workspace.approvals.field')}</th><th scope="col">{t('workspace.approvals.value')}</th></tr></thead>
        <tbody>
          {r.argumentsPreview.map((line) => (
            <tr key={line.path}>
              <th scope="row"><code>{line.path}</code></th>
              <td>{line.redacted ? <Badge tone="neutral"><Icon name="lock" size={12} />{t('workspace.approvals.redacted')}</Badge> : <span className={a.value}>{line.value}{line.truncated && <span className={a.trunc}> {t('workspace.approvals.truncated')}</span>}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DecideDialog({ act, onClose, onDone }: { act: Act; onClose(): void; onDone(text: string): void }) {
  const t = useT();
  const r = act.record;
  const [ttl, setTtl] = useState<number>(15);
  const [note, setNote] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const noteId = useId();
  const withNote = act.kind === 'approve' || act.kind === 'reject';

  async function go() {
    setWorking(true); setError(null);
    const trimmed = note.trim();
    const body: ApprovalAction = act.kind === 'approve' ? { action: 'approve', ttlSeconds: ttl * 60, ...(trimmed ? { note: trimmed } : {}) }
      : act.kind === 'reject' ? { action: 'reject', ...(trimmed ? { note: trimmed } : {}) }
        : { action: act.kind };
    const res = await workspaceApi().actOnApproval(r.id, body);
    setWorking(false);
    if (!res.ok) { setError(messageKeyFor(res)); return; }
    onDone(res.value.changed ? t(`workspace.approvals.done.${act.kind}`, { capability: label(r) }) : t('workspace.approvals.unchanged'));
  }

  return (
    <Dialog tone="alert" wide={act.kind === 'approve'} title={t(`workspace.approvals.confirm.${act.kind}`)} description={label(r)} onClose={onClose}
      footer={<>
        <button type="button" className={u.button} onClick={onClose} data-autofocus>{t('workspace.cancel')}</button>
        <button type="button" className={act.kind === 'approve' ? u.buttonPrimary : u.buttonDanger} onClick={() => void go()} disabled={working}>
          {working ? t('workspace.working') : t(`workspace.approvals.confirmButton.${act.kind}`)}
        </button>
      </>}>
      <p className={u.help}>{t(`workspace.approvals.explain.${act.kind}`)}</p>
      {act.kind === 'approve' && <Preview record={r} />}
      {act.kind === 'approve' && (
        <fieldset className={u.choices}>
          <legend>{t('workspace.approvals.ttl')}</legend>
          <div className={a.ttl}>
            {TTL_MINUTES.map((m) => (
              <label key={m} className={u.choice}><input type="radio" name="ttl" checked={ttl === m} onChange={() => setTtl(m)} /><span>{t('workspace.approvals.minutes', { count: m })}</span></label>
            ))}
          </div>
        </fieldset>
      )}
      {withNote && (
        <label className={u.field} htmlFor={noteId}>
          <span>{t('workspace.approvals.noteLabel')}</span>
          <textarea id={noteId} value={note} maxLength={NOTE_MAX} rows={3} onChange={(e) => setNote(e.target.value)} />
          <span className={u.counter} aria-hidden="true">{note.length}/{NOTE_MAX}</span>
        </label>
      )}
      {error && <p className={u.fieldError} role="alert">{t(error)}</p>}
    </Dialog>
  );
}
