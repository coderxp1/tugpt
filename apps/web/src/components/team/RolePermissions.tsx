'use client';

import s from '@/components/connect/connect.module.css';
import { useT } from '@/i18n/provider';
import type { MessageKey } from '@/i18n/types';
import { roleLabel } from '@/lib/team/roles';

type Cell = 'yes' | 'no' | 'nobody';
/** Only what the server enforces today (API route role checks and RLS); see the M4 report for sources. */
const ROWS: ReadonlyArray<{ key: MessageKey; owner: Cell; admin: Cell; others: Cell }> = [
  { key: 'team.perm.row.members', owner: 'yes', admin: 'yes', others: 'yes' },
  { key: 'team.perm.row.use', owner: 'yes', admin: 'yes', others: 'yes' },
  { key: 'team.perm.row.invite', owner: 'yes', admin: 'yes', others: 'no' },
  { key: 'team.perm.row.inviteOwner', owner: 'yes', admin: 'no', others: 'no' },
  { key: 'team.perm.row.providers', owner: 'yes', admin: 'yes', others: 'no' },
  { key: 'team.perm.row.mcp', owner: 'yes', admin: 'yes', others: 'no' },
  { key: 'team.perm.row.roles', owner: 'nobody', admin: 'nobody', others: 'nobody' },
];

/** Permission differences between roles, with the viewer's own column marked. */
export function RolePermissions({ role }: { role: string | null }) {
  const t = useT();
  const col = role === 'owner' ? 'owner' : role === 'admin' ? 'admin' : role ? 'others' : null;
  const text = (c: Cell) => t(c === 'yes' ? 'team.perm.yes' : c === 'no' ? 'team.perm.no' : 'team.perm.nobody');
  const head = (k: 'owner' | 'admin' | 'others', label: string) => (
    <th scope="col" aria-current={col === k ? 'true' : undefined} className={col === k ? s.permMine : undefined}>{label}</th>
  );
  return (
    <section className={s.card} aria-labelledby="perm-h" id="permissions" data-testid="role-permissions">
      <h2 id="perm-h">{t('team.perm.title')}</h2>
      <p className={s.next}>{t('team.perm.lead')}</p>
      {role && <p><span className={`${s.badge} ${s.ok}`}>{t('team.perm.yourRole', { role: roleLabel(role, t) })}</span></p>}
      <div className={s.tableWrap}><table className={`${s.table} ${s.stack}`}>
        <caption className={s.sr}>{t('team.perm.caption')}</caption>
        <thead><tr><th scope="col">{t('team.perm.colAction')}</th>{head('owner', t('team.perm.colOwner'))}{head('admin', t('team.perm.colAdmin'))}{head('others', t('team.perm.colOthers'))}</tr></thead>
        <tbody>{ROWS.map((r) => (
          <tr key={r.key}>
            <th scope="row">{t(r.key)}</th>
            {(['owner', 'admin', 'others'] as const).map((k) => (
              <td key={k} data-label={t(k === 'owner' ? 'team.perm.colOwner' : k === 'admin' ? 'team.perm.colAdmin' : 'team.perm.colOthers')} data-cell={r[k]}
                className={col === k ? s.permMine : undefined}>
                <span aria-hidden="true">{r[k] === 'yes' ? '✓ ' : r[k] === 'no' ? '— ' : ''}</span>{text(r[k])}
              </td>
            ))}
          </tr>))}
        </tbody>
      </table></div>
      <p className={s.muted}>{t('team.perm.note')}</p>
    </section>
  );
}
