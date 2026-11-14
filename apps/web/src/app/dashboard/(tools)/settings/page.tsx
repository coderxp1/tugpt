import type { Metadata } from 'next';
import Link from 'next/link';
import { getSessionContext } from '@/lib/tenant/server';
import s from '@/components/connect/connect.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Settings · TuGPT' };

const ROLE: Record<string, string> = { owner: 'Owner', admin: 'Administrator', manager: 'Manager', agent: 'Member', viewer: 'Viewer' };

export default async function SettingsPage() {
  const session = await getSessionContext();
  const t = session?.tenant;
  return (
    <div className={s.page}>
      <header className={s.head}><p className={s.eyebrow}>Settings</p><h1>Your account and organization</h1></header>
      <div className={s.grid}>
        <section className={s.card} aria-labelledby="profile-h">
          <h2 id="profile-h">Your profile</h2>
          <p className={s.next}>This is you. It stays the same in every organization you belong to.</p>
          <dl className={s.facts}><dt>Name</dt><dd>{session?.fullName ?? 'Not set'}</dd><dt>Email</dt><dd>{session?.email || 'Not available'}</dd></dl>
          <Link className={s.secondary} href="/auth/logout" prefetch={false}>Sign out</Link>
        </section>
        <section className={s.card} aria-labelledby="org-h">
          <h2 id="org-h">Organization</h2>
          <p className={s.next}>The workspace you are working in now. Data, chats and connections are kept separate per organization.</p>
          <dl className={s.facts}><dt>Name</dt><dd>{t?.organizationName ?? 'Not available'}</dd><dt>Your role</dt><dd>{t ? ROLE[t.role] ?? t.role : 'Not available'}</dd></dl>
          <Link className={s.secondary} href="/dashboard/connect">Manage connections</Link>
        </section>
      </div>
    </div>
  );
}
