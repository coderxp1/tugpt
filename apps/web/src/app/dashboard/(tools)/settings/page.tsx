import type { Metadata } from 'next';
import Link from 'next/link';
import { getSessionContext } from '@/lib/tenant/server';
import { createTranslator } from '@/i18n';
import { getRequestLocale } from '@/i18n/server';
import { OrganizationSwitcher } from '@/components/shell/OrganizationSwitcher';
import s from '@/components/connect/connect.module.css';
import { TeamInvitations } from '@/components/team/TeamInvitations';
import { MembersList } from '@/components/team/MembersList';
import { RolePermissions } from '@/components/team/RolePermissions';
import { LanguagePreference } from '@/components/team/LanguagePreference';
import { EmailText } from '@/components/team/EmailText';
import { FeatureStatusPanel } from '@/components/hub/FeatureStatusPanel';
import { loadMembers } from '@/lib/team/members.server';
import { loadOrgFeatures } from '@/lib/hub/features.server';
import { roleLabel } from '@/lib/team/roles';

export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  return { title: createTranslator(await getRequestLocale())('settings.meta.title') };
}

const SECTIONS = [
  ['profile-h', 'settings.nav.profile'], ['org-h', 'settings.nav.org'], ['language', 'settings.nav.language'],
  ['members', 'settings.nav.members'], ['permissions', 'settings.nav.permissions'], ['team', 'settings.nav.invitations'], ['features', 'settings.nav.features'],
] as const;

export default async function SettingsPage() {
  const [session, locale] = await Promise.all([getSessionContext(), getRequestLocale()]);
  const t = createTranslator(locale);
  const tenant = session?.tenant;
  const [members, features] = await Promise.all([tenant ? loadMembers(tenant.organizationId) : Promise.resolve(null), loadOrgFeatures()]);
  return (
    <div className={s.page}>
      <header className={s.head}><p className={s.eyebrow}>{t('settings.eyebrow')}</p><h1>{t('settings.title')}</h1>
        <p>{t('settings.lead')}</p></header>
      <nav aria-label={t('settings.nav')} className={s.actions}>
        {SECTIONS.map(([href, key]) => <a key={href} className={s.linkButton} href={`#${href}`}>{t(key)}</a>)}
      </nav>
      <div className={s.twoCol}>
        <section className={s.card} aria-labelledby="profile-h" data-testid="settings-profile">
          <h2 id="profile-h">{t('settings.profile.title')}</h2>
          <p className={s.next}>{t('settings.profile.lead')}</p>
          <dl className={s.facts}>
            <dt>{t('settings.field.name')}</dt><dd>{session?.fullName ?? t('settings.notSet')}</dd>
            <dt>{t('settings.field.email')}</dt><dd>{session?.email ? <EmailText value={session.email} /> : t('settings.notAvailable')}</dd>
          </dl>
          <p className={s.muted}>{t('settings.profile.source')}</p>
          <Link className={s.secondary} href="/auth/logout" prefetch={false}>{t('settings.signOut')}</Link>
        </section>
        <section className={s.card} aria-labelledby="org-h" data-testid="settings-org">
          <h2 id="org-h">{t('settings.org.title')}</h2>
          <p className={s.next}>{t('settings.org.lead')}</p>
          <dl className={s.facts}>
            <dt>{t('settings.field.orgName')}</dt><dd>{tenant?.organizationName ?? t('settings.notAvailable')}</dd>
            <dt>{t('settings.field.role')}</dt><dd data-testid="settings-role">{tenant ? roleLabel(tenant.role, t) : t('settings.notAvailable')}</dd>
            {members && <><dt>{t('settings.field.members')}</dt><dd>{members.length === 1 ? t('team.members.countOne') : t('team.members.count', { count: members.length })}</dd></>}
          </dl>
          <p className={s.muted}><a href="#permissions">{t('settings.org.roleHelp')}</a></p>
          <div className={s.actions}><Link className={s.secondary} href="/dashboard/connect">{t('settings.org.manageConnections')}</Link></div>
          <h3 className={s.sub}>{t('settings.org.switch')}</h3>
          <OrganizationSwitcher label={t('settings.org.switchButton')} currentId={tenant?.organizationId ?? null} />
        </section>
      </div>
      <LanguagePreference />
      <MembersList members={members} viewerId={session?.userId ?? null} viewerRole={tenant?.role ?? null} organizationName={tenant?.organizationName ?? null} />
      <RolePermissions role={tenant?.role ?? null} />
      <TeamInvitations role={tenant?.role ?? null} organizationName={tenant?.organizationName ?? null} />
      <FeatureStatusPanel features={features} />
    </div>
  );
}
