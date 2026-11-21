'use client';

import { useId, useState } from 'react';
import { BACKEND_GAPS } from '@/lib/connect-ui/contract';
import { PERMISSION_LEVELS, permissionText, type EndpointStatus, type McpTool, type PermissionLevel } from '@/lib/connect-ui/mcp';
import { useT } from '@/i18n/provider';
import { GapNote } from './GapNote';
import s from './connect.module.css';

export interface McpToolReviewProps {
  /** Tools as stored by the backend for this snapshot (GET /mcp/snapshots/{id}/tools). */
  tools: readonly McpTool[];
  /** From the backend: the snapshot's approved flag (GET /mcp/endpoints). */
  approved: boolean;
  /** The server's status; decides what an approved tool's status reads. */
  serverStatus?: EndpointStatus;
  /** Absent: approving is switched off (customer MCP disabled or route missing); the list stays read-only. */
  onApprove?(permissions: Record<string, PermissionLevel>): Promise<string | null>;
  lockedNote?: React.ReactNode;
}

/**
 * Review step before any MCP tool can be activated. Shows each tool's stored
 * permission level. Approving requires an explicit choice for every tool (the
 * stored default is not pre-selected) plus a confirmation that the
 * descriptions were read. An approved list shows each tool's status instead.
 */
export function McpToolReview({ tools, approved, serverStatus = 'pending', onApprove, lockedNote }: McpToolReviewProps) {
  const t = useT();
  const [levels, setLevels] = useState<Record<string, PermissionLevel>>({});
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  const editable = !approved && Boolean(onApprove);

  if (tools.length === 0) return <p className={s.muted}>{t('mcp.review.none')}</p>;
  const left = tools.filter((x) => !levels[x.name]).length;
  const complete = left === 0;
  const risky = (editable ? tools.map((x) => levels[x.name]) : tools.map((x) => x.permissionClass)).some((l) => l && l !== 'read');
  const toolState = approved
    ? serverStatus === 'active' ? t('mcp.toolState.active') : serverStatus === 'disabled' ? t('mcp.toolState.disabled') : t('mcp.toolState.approved')
    : t('mcp.toolState.review');

  async function approve() {
    if (!onApprove || !complete || !reviewed) return;
    setBusy(true); setProblem(null);
    const err = await onApprove(Object.fromEntries(tools.map((x) => [x.name, levels[x.name]])));
    setBusy(false);
    if (err) setProblem(err);
  }

  return (
    <fieldset className={s.review} disabled={busy}>
      <legend>{approved ? t('mcp.review.legendApproved', { count: tools.length }) : t('mcp.review.legend', { count: tools.length })}</legend>
      <p className={s.muted}>{approved ? t('mcp.review.statusApproved') : t('mcp.review.statusPending')}</p>
      <div className={s.tableWrap}>
        <table className={`${s.table} ${s.stack}`}>
          <thead>
            <tr>
              <th scope="col">{t('mcp.review.colTool')}</th><th scope="col">{t('mcp.review.colDesc')}</th><th scope="col">{t('mcp.review.colLevel')}</th>
              <th scope="col">{t('mcp.review.colState')}</th>
              {editable && <th scope="col">{t('mcp.review.colDecision')}</th>}
            </tr>
          </thead>
          <tbody>
            {tools.map((x) => (
              <tr key={x.name}>
                <th scope="row" data-label={t('mcp.review.colTool')}><code>{x.name}</code></th>
                <td data-label={t('mcp.review.colDesc')}>{x.description || <em>{t('mcp.review.noDesc')}</em>}</td>
                <td data-label={t('mcp.review.colLevel')}>{permissionText(x.permissionClass, t).label}{!approved && x.permissionClass === 'write' && <><br /><small className={s.soon}>{t('mcp.review.safeDefault')}</small></>}</td>
                <td data-label={t('mcp.review.colState')}><span className={`${s.badge} ${approved && serverStatus === 'active' ? s.ok : approved ? s.off : s.idle}`}>{toolState}</span></td>
                {editable && (
                  <td data-label={t('mcp.review.colDecision')}>
                    <label className={s.sr} htmlFor={`${id}-${x.name}`}>{t('mcp.review.levelFor', { tool: x.name })}</label>
                    <select id={`${id}-${x.name}`} value={levels[x.name] ?? ''} onChange={(e) => setLevels((l) => ({ ...l, [x.name]: e.target.value as PermissionLevel }))}>
                      <option value="" disabled>{t('mcp.review.choose')}</option>
                      {PERMISSION_LEVELS.map((p) => <option key={p} value={p}>{permissionText(p, t).label}</option>)}
                    </select>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={s.muted}><small>{t('mcp.review.descNote')}</small></p>
      <dl className={s.levels}>{PERMISSION_LEVELS.map((p) => <div key={p}><dt>{permissionText(p, t).label}</dt><dd>{permissionText(p, t).help}</dd></div>)}</dl>
      {risky && <GapNote gap={BACKEND_GAPS.CALL_APPROVAL}>Tools that are not Read only are blocked on every use until an owner or admin approves that exact call in the approval card in Chat. An approval covers one call with exactly those arguments and expires.</GapNote>}
      {editable ? (
        <>
          <label className={s.check}><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> {t('mcp.review.confirm')}</label>
          {!complete && <p className={s.muted} data-testid="mcp-review-left">{t('mcp.review.missing', { left })}</p>}
          {problem && <p className={s.error} role="alert">{problem}</p>}
          <button type="button" className={s.primary} onClick={() => void approve()} disabled={!complete || !reviewed}>
            {busy ? t('mcp.review.approving') : t('mcp.review.approve')}
          </button>
        </>
      ) : !approved && lockedNote}
    </fieldset>
  );
}
