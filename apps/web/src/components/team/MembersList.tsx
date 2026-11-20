import type { Member } from '@/lib/team/members.server';
import s from '@/components/connect/connect.module.css';
import { EmailText } from './EmailText';

const ROLE: Record<string, string> = { owner: 'Owner', admin: 'Administrator', manager: 'Manager', agent: 'Member', viewer: 'Viewer' };
const ROLES = ['viewer', 'agent', 'manager', 'admin', 'owner'];
const date = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); };
export const MEMBER_ACTIONS_NOTE = 'Changing a role or removing a member is not available yet. TuGPT cannot carry out these changes yet, so the controls are switched off and nothing is changed.';

/**
 * Member list. Role change and removal are shown to owners and administrators so the
 * layout is ready, but stay disabled: the backend offers no operation for them yet
 * (authenticated has no UPDATE/DELETE grant on organization_members). Never simulated.
 */
export function MembersList({ members, viewerId, viewerRole = null, organizationName }: { members: readonly Member[] | null; viewerId: string | null; viewerRole?: string | null; organizationName: string | null }) {
  const manager = viewerRole === 'owner' || viewerRole === 'admin';
  return (
    <section className={s.card} aria-labelledby="members-h" id="members">
      <div className={s.cardHead}>
        <h2 id="members-h">Members</h2>
        {members && <span className={`${s.badge} ${s.idle}`}>{members.length} {members.length === 1 ? 'person' : 'people'}</span>}
      </div>
      <p className={s.next}>Everyone who can work in {organizationName ?? 'this organization'}, and the role that decides what they can do.</p>
      {members === null
        ? <p className={s.error} role="alert">The member list could not be loaded. Reload the page to try again.</p>
        : members.length === 0 ? <p className={s.muted}>No members found.</p>
        : <div className={s.tableWrap}><table className={`${s.table} ${s.stack}`}>
            <caption className={s.sr}>Members of {organizationName ?? 'this organization'}</caption>
            <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Joined</th>{manager && <th scope="col">Manage</th>}</tr></thead>
            <tbody>{members.map((m) => {
              const self = m.userId === viewerId;
              const name = m.name ?? 'No name set';
              return (
              <tr key={m.userId} data-member={self ? 'self' : 'other'}>
                <td data-label="Name"><strong className={s.memberName}>{name}</strong>{self && <span className={`${s.badge} ${s.ok}`} style={{ marginLeft: 8 }}>You</span>}</td>
                <td data-label="Email">{m.email ? <EmailText value={m.email} /> : '—'}</td>
                <td data-label="Role">{ROLE[m.role] ?? m.role}</td>
                <td data-label="Joined" className={s.nowrap}>{date(m.joinedAt)}</td>
                {manager && <td data-label="Manage">{self
                  ? <span className={s.muted}>You cannot change your own role here.</span>
                  : <div className={s.rowActions}>
                      <label className={s.sr} htmlFor={`role-${m.userId}`}>Role for {name}</label>
                      <select id={`role-${m.userId}`} className={s.select} defaultValue={m.role} disabled aria-describedby="member-actions-note">
                        {ROLES.map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}
                      </select>
                      <button type="button" className={s.secondary} disabled aria-describedby="member-actions-note" aria-label={`Remove ${name} (not available yet)`}>Remove</button>
                    </div>}</td>}
              </tr>);
            })}</tbody>
          </table></div>}
      {manager && members !== null && members.length > 0 && <p className={s.notice} id="member-actions-note"><strong>Not available yet:</strong> {MEMBER_ACTIONS_NOTE.replace('Changing a role or removing a member is not available yet. ', '')}</p>}
    </section>
  );
}
