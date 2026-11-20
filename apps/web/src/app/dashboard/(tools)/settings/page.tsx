import type { Metadata } from 'next';
import Link from 'next/link';
import { getSessionContext } from '@/lib/tenant/server';
import { OrganizationSwitcher } from '@/components/shell/OrganizationSwitcher';
import s from '@/components/connect/connect.module.css';
import { TeamInvitations } from '@/components/team/TeamInvitations';
import { MembersList } from '@/components/team/MembersList';
import { FeatureStatusPanel } from '@/components/hub/FeatureStatusPanel';
import { loadMembers } from '@/lib/team/members.server';
import { loadOrgFeatures } from '@/lib/hub/features.server';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Settings · TuGPT' };

const ROLE: Record<string, string> = { owner: 'Owner', admin: 'Administrator', manager: 'Manager', agent: 'Member', viewer: 'Viewer' };

export default async function SettingsPage() {
  const session = await getSessionContext();
  const t = session?.tenant;
  const [members, features] = await Promise.all([t ? loadMembers(t.organizationId) : Promise.resolve(null), loadOrgFeatures()]);
  return (
    <div className={s.page}>
      <header className={s.head}><p className={s.eyebrow}>Settings</p><h1>Your account and organization</h1>
        <p>Your profile, the organization you are working in, its members and what it can use in TuGPT.</p></header>
      <nav aria-label="Settings sections" className={s.actions}>
        <a className={s.linkButton} href="#profile-h">Profile</a><a className={s.linkButton} href="#org-h">Organization</a>
        <a className={s.linkButton} href="#members">Members</a><a className={s.linkButton} href="#team">Invitations</a><a className={s.linkButton} href="#features">Features</a>
      </nav>
      <div className={s.grid}>
        <section className={s.card} aria-labelledby="profile-h">
          <h2 id="profile-h">Your profile</h2>
          <p className={s.next}>This is you. It stays the same in every organization you belong to.</p>
          <dl className={s.facts}><dt>Name</dt><dd>{session?.fullName ?? 'Not set'}</dd><dt>Email</dt><dd>{session?.email || 'Not available'}</dd></dl>
          <p className={s.muted}>Your name and email come from your company sign-in and are changed there.</p>
          <Link className={s.secondary} href="/auth/logout" prefetch={false}>Sign out</Link>
        </section>
        <section className={s.card} aria-labelledby="org-h">
          <h2 id="org-h">Organization</h2>
          <p className={s.next}>The workspace you are working in now. Data, chats and connections are kept separate per organization.</p>
          <dl className={s.facts}><dt>Name</dt><dd>{t?.organizationName ?? 'Not available'}</dd><dt>Your role</dt><dd>{t ? ROLE[t.role] ?? t.role : 'Not available'}</dd></dl>
          <div className={s.actions}><Link className={s.secondary} href="/dashboard/connect">Manage connections</Link></div>
          <h3 className={s.sub}>Switch organization</h3>
          <OrganizationSwitcher label="Show my organizations" currentId={t?.organizationId ?? null} />
        </section>
        <MembersList members={members} viewerId={session?.userId ?? null} organizationName={t?.organizationName ?? null} />
        <div id="team"><TeamInvitations role={t?.role ?? null} organizationName={t?.organizationName ?? null} /></div>
      </div>
      <FeatureStatusPanel features={features} />
    </div>
  );
}
