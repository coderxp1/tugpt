'use client';

import type { Member } from '@/lib/team/members.server';
import s from '@/components/connect/connect.module.css';
import { useT } from '@/i18n/provider';
import { formatDate } from '@/i18n';
import { canManageOrg, roleLabel } from '@/lib/team/roles';
import { EmailText } from './EmailText';

/**
 * Member list. Changing a role or removing a member is not offered by the
 * backend (authenticated has no UPDATE/DELETE grant on organization_members),
 * so there are no controls for it at all: a disabled select still looks like a
 * feature. Owners and admins get one plain explanation instead. Never simulated.
 */
export function MembersList({ members, viewerId, viewerRole = null, organizationName }: { members: readonly Member[] | null; viewerId: string | null; viewerRole?: string | null; organizationName: string | null }) {
  const t = useT();
  const manager = canManageOrg(viewerRole);
  const org = organizationName ?? t('team.thisOrg');
  return (
    <section className={s.card} aria-labelledby="members-h" id="members">
      <div className={s.cardHead}>
        <h2 id="members-h">{t('team.members.title')}</h2>
        {members && <span className={`${s.badge} ${s.idle}`} data-testid="member-count">{members.length === 1 ? t('team.members.countOne') : t('team.members.count', { count: members.length })}</span>}
      </div>
      <p className={s.next}>{t('team.members.lead', { org })}</p>
      {members === null
        ? <p className={s.error} role="alert">{t('team.members.loadFailed')}</p>
        : members.length === 0 ? <p className={s.muted}>{t('team.members.empty')}</p>
        : <div className={s.tableWrap}><table className={`${s.table} ${s.stack}`}>
            <caption className={s.sr}>{t('team.members.caption', { org })}</caption>
            <thead><tr><th scope="col">{t('team.col.name')}</th><th scope="col">{t('team.col.email')}</th><th scope="col">{t('team.col.role')}</th><th scope="col">{t('team.col.joined')}</th></tr></thead>
            <tbody>{members.map((m) => {
              const self = m.userId === viewerId;
              return (
              <tr key={m.userId} data-member={self ? 'self' : 'other'} data-role={m.role}>
                <td data-label={t('team.col.name')}><strong className={s.memberName}>{m.name ?? t('team.noName')}</strong>{self && <span className={`${s.badge} ${s.ok}`} style={{ marginLeft: 8 }}>{t('team.you')}</span>}</td>
                <td data-label={t('team.col.email')}>{m.email ? <EmailText value={m.email} /> : '—'}</td>
                <td data-label={t('team.col.role')}>{roleLabel(m.role, t)}</td>
                <td data-label={t('team.col.joined')} className={s.nowrap}>{formatDate(m.joinedAt, t.locale) || '—'}</td>
              </tr>);
            })}</tbody>
          </table></div>}
      {manager && members !== null && (
        <div className={s.notice} id="member-actions-note" data-testid="member-changes-note">
          <p><strong>{t('team.members.changesTitle')}:</strong> {t('team.members.changesBody')}</p>
          <p>{t('team.members.changesOwner')}</p>
        </div>
      )}
    </section>
  );
}
