'use client';

import { useId, useState } from 'react';
import { BACKEND_GAPS } from '@/lib/connect-ui/contract';
import { PERMISSION_LEVELS, PERMISSION_TEXT, type McpTool, type PermissionLevel } from '@/lib/connect-ui/mcp';
import { GapNote } from './GapNote';
import s from './connect.module.css';

export interface McpToolReviewProps {
  /** null: the discovered tools cannot be read on this build (B-2), so approval stays locked. */
  tools: readonly McpTool[] | null;
  toolCount: number;
  onApprove?(permissions: Record<string, PermissionLevel>): Promise<string | null>;
}

/**
 * Review step before any MCP tool can be activated. Every tool needs an
 * explicit permission level (no defaults), plus a confirmation that the
 * descriptions were read. Approving tools nobody has seen is not possible.
 */
export function McpToolReview({ tools, toolCount, onApprove }: McpToolReviewProps) {
  const [levels, setLevels] = useState<Record<string, PermissionLevel>>({});
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();

  if (tools === null) {
    return (
      <GapNote gap={BACKEND_GAPS.B2}>
        TuGPT found {toolCount} {toolCount === 1 ? 'tool' : 'tools'} but cannot show their names and descriptions yet, so they cannot be reviewed. Approval stays locked until they can be read.
      </GapNote>
    );
  }
  const complete = tools.length > 0 && tools.every((t) => levels[t.name]);
  const risky = tools.some((t) => levels[t.name] && levels[t.name] !== 'read');

  async function approve() {
    if (!onApprove || !complete || !reviewed) return;
    setBusy(true); setProblem(null);
    const err = await onApprove(Object.fromEntries(tools!.map((t) => [t.name, levels[t.name]])));
    setBusy(false);
    if (err) setProblem(err);
  }

  return (
    <fieldset className={s.review} disabled={busy}>
      <legend>Review {tools.length} {tools.length === 1 ? 'tool' : 'tools'}</legend>
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead><tr><th scope="col">Tool</th><th scope="col">What it says it does</th><th scope="col">Permission level</th></tr></thead>
          <tbody>
            {tools.map((t) => (
              <tr key={t.name}>
                <th scope="row"><code>{t.name}</code></th>
                <td>{t.description || <em>No description provided by the server.</em>}</td>
                <td>
                  <label className={s.sr} htmlFor={`${id}-${t.name}`}>Permission level for {t.name}</label>
                  <select id={`${id}-${t.name}`} value={levels[t.name] ?? ''} onChange={(e) => setLevels((l) => ({ ...l, [t.name]: e.target.value as PermissionLevel }))}>
                    <option value="" disabled>Choose…</option>
                    {PERMISSION_LEVELS.map((p) => <option key={p} value={p}>{PERMISSION_TEXT[p].label}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className={s.levels}>{PERMISSION_LEVELS.map((p) => <div key={p}><dt>{PERMISSION_TEXT[p].label}</dt><dd>{PERMISSION_TEXT[p].help}</dd></div>)}</dl>
      {risky && <GapNote gap={BACKEND_GAPS.B7}>Tools that make changes cannot ask for your approval on each use yet. Choose Read only only for tools that really change nothing.</GapNote>}
      <label className={s.check}><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> I read what each tool does and chose its level on purpose.</label>
      {problem && <p className={s.error} role="alert">{problem}</p>}
      <button type="button" className={s.primary} onClick={() => void approve()} disabled={!onApprove || !complete || !reviewed}>
        {busy ? 'Approving…' : 'Approve these tools'}
      </button>
      <p className={s.muted}>An approved list is frozen. If the server&rsquo;s tools change, discover again and review the new list.</p>
    </fieldset>
  );
}
