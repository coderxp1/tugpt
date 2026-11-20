import type { Member } from '@/lib/team/members.server';
import s from '@/components/connect/connect.module.css';

const ROLE: Record<string, string> = { owner: 'Owner', admin: 'Administrator', manager: 'Manager', agent: 'Member', viewer: 'Viewer' };
const date = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); };

/** Read-only member list. It never offers an action the backend cannot perform. */
export function MembersList({ members, viewerId, organizationName }: { members: readonly Member[] | null; viewerId: string | null; organizationName: string | null }) {
  return (
    <section className={s.card} aria-labelledby="members-h" id="members">
      <div className={s.cardHead}>
        <h2 id="members-h">Members</h2>
        {members && <span className={`${s.badge} ${s.idle}`}>{members.length} {members.length === 1 ? 'person' : 'people'}</span>}
      </div>
      <p className={s.next}>Everyone who can work in {organizationName ?? 'this organization'}.</p>
      {members === null
        ? <p className={s.error} role="alert">The member list could not be loaded. Reload the page to try again.</p>
        : members.length === 0 ? <p className={s.muted}>No members found.</p>
        : <div className={s.tableWrap}><table className={s.table}>
            <caption className={s.sr}>Members of {organizationName ?? 'this organization'}</caption>
            <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Member since</th></tr></thead>
            <tbody>{members.map((m) => (
              <tr key={m.userId}>
                <td>{m.name ?? 'No name set'}{m.userId === viewerId && <strong> (you)</strong>}</td>
                <td>{m.email ?? '—'}</td>
                <td>{ROLE[m.role] ?? m.role}</td>
                <td>{date(m.joinedAt)}</td>
              </tr>))}
            </tbody>
          </table></div>}
      <p className={s.muted}>Changing a member&rsquo;s role or removing a member is not available in the Dashboard yet.</p>
    </section>
  );
}
