'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Member } from '@/lib/team/members.server';
import s from '@/components/connect/connect.module.css';
import { useT } from '@/i18n/provider';
import { formatDate } from '@/i18n';
import { canManageOrg, roleLabel } from '@/lib/team/roles';
import { filterMembers, MEMBER_QUERY_MAX } from '@/lib/team/memberSearch';
import { EmailText } from './EmailText';

/** Wait this long after the last keystroke before the result count is announced. */
export const ANNOUNCE_DELAY_MS = 400;

/**
 * Member list with search. Changing a role or removing a member is not offered
 * by the backend (authenticated has no UPDATE/DELETE grant on
 * organization_members), so there are no controls for it at all: a disabled
 * select still looks like a feature. Owners and admins get one plain
 * explanation instead. Never simulated.
 *
 * Search filters the list the server already returned, in the browser: name,
 * email and role label as shown, ignoring case and accents. It reveals nothing
 * the list did not already show and sends no requests.
 */
export function MembersList({ members, viewerId, viewerRole = null, organizationName }: { members: readonly Member[] | null; viewerId: string | null; viewerRole?: string | null; organizationName: string | null }) {
  const t = useT();
  const manager = canManageOrg(viewerRole);
  const org = organizationName ?? t('team.thisOrg');
  const uid = useId();
  const ids = { input: `${uid}-q`, hint: `${uid}-hint`, results: `${uid}-results` };
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [announced, setAnnounced] = useState('');

  const searching = query.trim() !== '';
  const shown = useMemo(() => (members ? filterMembers(members, query, (r) => roleLabel(r, t)) : []), [members, query, t]);
  const total = members?.length ?? 0;
  const quoted = query.trim().slice(0, 60);
  const resultText = !searching ? ''
    : shown.length === 0 ? t('team.search.none', { query: quoted })
    : total === 1 ? t('team.search.resultOnly')
    : shown.length === 1 ? t('team.search.resultOne', { total })
    : t('team.search.result', { shown: shown.length, total });

  // Announce once typing pauses, so a screen reader is not interrupted on every key.
  useEffect(() => {
    const timer = setTimeout(() => setAnnounced(resultText), searching ? ANNOUNCE_DELAY_MS : 0);
    return () => clearTimeout(timer);
  }, [resultText, searching]);

  const clear = () => { setQuery(''); setAnnounced(''); inputRef.current?.focus(); };

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
        : <>
            <div className={s.memberSearch} role="search" aria-label={t('team.search.region')}>
              <label htmlFor={ids.input}>{t('team.search.label')}</label>
              <div className={s.searchBox}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
                <input
                  ref={inputRef} id={ids.input} type="search" value={query} maxLength={MEMBER_QUERY_MAX}
                  placeholder={t('team.search.placeholder')} autoComplete="off" spellCheck={false}
                  aria-describedby={ids.hint} aria-controls={ids.results}
                  onChange={(e) => { setQuery(e.target.value); if (!e.target.value.trim()) setAnnounced(''); }}
                  onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); clear(); } }}
                />
              </div>
              <p id={ids.hint} className={s.muted}>{t('team.search.hint')}</p>
            </div>
            <p className={s.searchStatus} role="status" aria-live="polite" aria-atomic="true" data-testid="member-search-status">{announced}</p>
            <div id={ids.results} data-testid="member-search-results">
            {shown.length === 0
              ? (
                <div className={s.notice} data-testid="member-search-empty">
                  <p><strong>{t('team.search.none', { query: quoted })}</strong></p>
                  <p>{t('team.search.noneHelp')}{manager ? ` ${t('team.search.noneInvited')}` : ''}</p>
                  <p><button type="button" className={s.secondary} onClick={clear}>{t('team.search.clear')}</button></p>
                </div>)
              : <div className={s.tableWrap}><table className={`${s.table} ${s.stack}`}>
                  <caption className={s.sr}>{t('team.members.caption', { org })}</caption>
                  <thead><tr><th scope="col">{t('team.col.name')}</th><th scope="col">{t('team.col.email')}</th><th scope="col">{t('team.col.role')}</th><th scope="col">{t('team.col.joined')}</th></tr></thead>
                  <tbody>{shown.map((m) => {
                    const self = m.userId === viewerId;
                    return (
                    <tr key={m.userId} data-member={self ? 'self' : 'other'} data-role={m.role}>
                      <td data-label={t('team.col.name')}><strong className={s.memberName}>{m.name ?? t('team.noName')}</strong>{self && <>{' '}<span className={`${s.badge} ${s.ok}`} style={{ marginLeft: 4 }}>{t('team.you')}</span></>}</td>
                      <td data-label={t('team.col.email')}>{m.email ? <EmailText value={m.email} /> : '—'}</td>
                      <td data-label={t('team.col.role')}>{roleLabel(m.role, t)}</td>
                      <td data-label={t('team.col.joined')} className={s.nowrap}>{formatDate(m.joinedAt, t.locale) || '—'}</td>
                    </tr>);
                  })}</tbody>
                </table></div>}
            </div>
          </>}
      {manager && members !== null && (
        <div className={s.notice} id="member-actions-note" data-testid="member-changes-note">
          <p><strong>{t('team.members.changesTitle')}:</strong> {t('team.members.changesBody')}</p>
          <p>{t('team.members.changesOwner')}</p>
        </div>
      )}
    </section>
  );
}
