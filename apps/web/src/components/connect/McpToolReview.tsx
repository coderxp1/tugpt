'use client';

import { useId, useState } from 'react';
import { BACKEND_GAPS } from '@/lib/connect-ui/contract';
import { PERMISSION_LEVELS, PERMISSION_TEXT, type McpTool, type PermissionLevel } from '@/lib/connect-ui/mcp';
import { GapNote } from './GapNote';
import s from './connect.module.css';

export interface McpToolReviewProps {
  /** Tools as stored by the backend for this snapshot (GET /mcp/snapshots/{id}/tools). */
  tools: readonly McpTool[];
  /** Known from a real approve response (or ALREADY_APPROVED) in this session. */
  approved: boolean;
  /** Absent: approving is switched off (customer MCP disabled or route missing); the list stays read-only. */
  onApprove?(permissions: Record<string, PermissionLevel>): Promise<string | null>;
  lockedNote?: React.ReactNode;
}

/**
 * Review step before any MCP tool can be activated. Shows each tool's stored
 * permission class. Approving requires an explicit choice for every tool (the
 * stored default is not pre-selected) plus a confirmation that the
 * descriptions were read.
 */
export function McpToolReview({ tools, approved, onApprove, lockedNote }: McpToolReviewProps) {
  const [levels, setLevels] = useState<Record<string, PermissionLevel>>({});
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  const editable = !approved && Boolean(onApprove);

  if (tools.length === 0) return <p className={s.muted}>The server did not offer any tools when TuGPT checked it.</p>;
  const complete = tools.every((t) => levels[t.name]);
  const risky = (editable ? tools.map((t) => levels[t.name]) : tools.map((t) => t.permissionClass)).some((l) => l && l !== 'read');

  async function approve() {
    if (!onApprove || !complete || !reviewed) return;
    setBusy(true); setProblem(null);
    const err = await onApprove(Object.fromEntries(tools.map((t) => [t.name, levels[t.name]])));
    setBusy(false);
    if (err) setProblem(err);
  }

  return (
    <fieldset className={s.review} disabled={busy}>
      <legend>{approved ? 'Approved tools' : `Review ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}`}</legend>
      <p className={s.muted} role="status">
        {approved ? 'Approved. This list is frozen.' : 'Not approved. Nothing from this server can be activated until an owner or admin approves it.'}
      </p>
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">Tool</th><th scope="col">What it says it does</th><th scope="col">Current setting</th>
              {editable && <th scope="col">Your decision</th>}
            </tr>
          </thead>
          <tbody>
            {tools.map((t) => (
              <tr key={t.name}>
                <th scope="row"><code>{t.name}</code></th>
                <td>{t.description || <em>No description provided by the server.</em>}</td>
                <td>{PERMISSION_TEXT[t.permissionClass].label}{!approved && t.permissionClass === 'write' && <><br /><small className={s.soon}>safe default until you choose</small></>}</td>
                {editable && (
                  <td>
                    <label className={s.sr} htmlFor={`${id}-${t.name}`}>Permission level for {t.name}</label>
                    <select id={`${id}-${t.name}`} value={levels[t.name] ?? ''} onChange={(e) => setLevels((l) => ({ ...l, [t.name]: e.target.value as PermissionLevel }))}>
                      <option value="" disabled>Choose…</option>
                      {PERMISSION_LEVELS.map((p) => <option key={p} value={p}>{PERMISSION_TEXT[p].label}</option>)}
                    </select>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className={s.levels}>{PERMISSION_LEVELS.map((p) => <div key={p}><dt>{PERMISSION_TEXT[p].label}</dt><dd>{PERMISSION_TEXT[p].help}</dd></div>)}</dl>
      {risky && <GapNote gap={BACKEND_GAPS.CALL_APPROVAL}>Tools that are not Read only are blocked on every use until an owner or admin approves that exact call in the approval card in Chat. An approval covers one call with exactly those arguments and expires.</GapNote>}
      {editable ? (
        <>
          <label className={s.check}><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> I read what each tool does and chose its level on purpose.</label>
          {problem && <p className={s.error} role="alert">{problem}</p>}
          <button type="button" className={s.primary} onClick={() => void approve()} disabled={!complete || !reviewed}>
            {busy ? 'Approving…' : 'Approve these tools'}
          </button>
          <p className={s.muted}>An approved list is frozen. If the server&rsquo;s tools change, discover again and review the new list.</p>
        </>
      ) : !approved && lockedNote}
    </fieldset>
  );
}
