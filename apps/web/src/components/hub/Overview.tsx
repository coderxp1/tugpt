'use client';
/**
 * The Dashboard Overview as a control center: what this organization can use
 * now (with the action that opens it), what needs setup, what is switched off
 * and by whom it is switched on, what is held for review, what could not be
 * checked, and, by name only, what is not part of TuGPT yet.
 *
 * Every row comes from describeFeatures (lib/hub/features.ts), which only
 * reports a state a real gate returned. This component adds no claims.
 */
import Link from 'next/link';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/provider';
import type { ProductView } from '@/lib/hub/products';
import { NOT_YET, sectionOf, stateLabel, type FeatureStatus, type OverviewSection } from '@/lib/hub/features';
import s from './control.module.css';
import r from './reference.module.css';

export interface OverviewProps {
  readonly statuses: readonly FeatureStatus[];
  readonly products: readonly ProductView[];
  readonly hasOrganization: boolean;
  readonly organizationName?: string | null;
  readonly firstName?: string | null;
}

const TONE: Record<OverviewSection, string> = { ready: s.ready, setup: s.setup, disabled: s.off, review: s.review, unknown: s.unknown, later: s.off };

export function Overview({ statuses, products, hasOrganization, organizationName = null, firstName = null }: OverviewProps) {
  const t = useT();
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const by = (sec: OverviewSection) => statuses.filter((f) => sectionOf(f.state) === sec);
  const workspace = statuses.find((f) => f.key === 'chat');
  const workspaceReady = workspace ? sectionOf(workspace.state) === 'ready' : false;
  const waiting = products.filter((p) => p.state === 'attention' && p.href && (!p.featureAccess || p.featureAccess === 'enabled'));
  // Not part of TuGPT yet: features with their own page (e.g. a provider TuGPT does not offer yet) get a row
  // that explains why; everything else is listed by name only.
  const laterRows = statuses.filter((f) => f.state === 'not_implemented' && f.href);
  const laterNames = [...new Set(NOT_YET.map((k) => t(`notyet.${k}`)))];

  const badge = (f: FeatureStatus) => <span className={`${s.badge} ${TONE[sectionOf(f.state)]}`}>{f.state === 'partial' ? t('cc.partly') : stateLabel(f.state, t)}</span>;

  const head = (sec: Exclude<OverviewSection, 'later'> | 'later', count: number) => (
    <div className={s.secHead}>
      <h2 id={`cc-${sec}`}>{t(`cc.sec.${sec}`)} <span className={s.count}>{count}</span></h2>
      <p>{t(`cc.sec.${sec}.lead`)}</p>
    </div>
  );

  const ready = by('ready');
  const setup = by('setup');
  const rows: ['disabled' | 'review' | 'unknown', FeatureStatus[]][] = [['disabled', by('disabled')], ['review', by('review')], ['unknown', by('unknown')]];
  const rowList = (list: readonly FeatureStatus[]) => <ul className={s.rows}>
    {list.map((f) => <li key={f.key} className={s.row} data-feature={f.key} data-state={f.state}>
      <div className={s.rowName}><h3>{f.name}</h3>{badge(f)}</div>
      <div className={s.rowBody}><p>{f.detail}</p>{f.who && <p className={s.who}>{f.who}</p>}</div>
      {f.href && <Link href={f.href} prefetch={false} className={s.rowLink}>{t('cc.learnMore')}<span className={r.sr}>: {f.name}</span></Link>}
    </li>)}
  </ul>;

  return <div className={s.cc}>
    <header className={s.head}>
      <div>
        <p className={r.eyebrow}>{t('cc.eyebrow')}{organizationName ? <> · <span data-testid="cc-org">{organizationName}</span></> : null}</p>
        <h1>{firstName ? t('cc.title', { name: firstName }) : t('cc.titleNoName')}</h1>
        <p className={s.lead}>{organizationName ? t('cc.lead', { org: organizationName }) : t('cc.leadNoOrg')}</p>
      </div>
      <div className={s.headActions}>
        <button className={s.ghost} type="button" disabled={pending} onClick={() => startTransition(() => router.refresh())}>{pending ? t('cc.refreshing') : t('cc.refresh')}</button>
        <span className={r.sr} role="status">{pending ? t('cc.refreshingSr') : ''}</span>
      </div>
    </header>

    {!hasOrganization && <p className={s.notice} role="status">{t('cc.noOrg')}</p>}

    {workspace && <section className={s.front} aria-labelledby="cc-workspace" data-testid="cc-workspace" data-state={workspace.state}>
      <div className={s.frontCopy}>
        <h2 id="cc-workspace">{t('shell.section.workspace')}</h2>
        <p>{workspaceReady ? t('cc.workspaceLead') : workspace.detail}</p>
        {!workspaceReady && workspace.who && <p className={s.who}>{workspace.who}</p>}
      </div>
      <div className={s.frontActions}>
        {workspaceReady
          ? <Link href="/workspace" prefetch={false} className={s.cta}>{t('cc.openWorkspace')} <span aria-hidden="true">→</span></Link>
          : badge(workspace)}
        {workspaceReady && <ul className={s.jump} aria-label={t('shell.nav.workspaceAria')}>
          {statuses.filter((f) => f.group === 'workspace' && f.key !== 'chat' && f.href && sectionOf(f.state) === 'ready').map((f) => <li key={f.key}><Link href={f.href!} prefetch={false}>{f.name}</Link></li>)}
        </ul>}
      </div>
    </section>}

    {waiting.length > 0 && <div className={s.attention} role="status">
      <strong>{t('overview.attention')}</strong>
      <span>{t('overview.att.waiting')}</span>
      {waiting.map((p) => <Link key={p.id} href={p.href!} prefetch={false}>{t(p.titleKey)}{p.metric !== null && p.metricKey ? ` · ${p.metric} ${t(p.metricKey)}` : ''}</Link>)}
    </div>}

    <div className={s.sections}>
      <section aria-labelledby="cc-ready" data-section="ready">
        {head('ready', ready.length)}
        {ready.length === 0 ? <p className={s.empty}>{t('cc.readyEmpty')}</p> : <ul className={s.grid}>
          {ready.map((f) => <li key={f.key} className={s.card} data-feature={f.key} data-state={f.state}>
            <div className={s.cardTop}><h3>{f.name}</h3>{badge(f)}</div>
            <p>{f.detail}</p>
            {f.action && <Link href={f.action.href} prefetch={false} className={s.action}>{f.action.label} <span aria-hidden="true">→</span></Link>}
          </li>)}
        </ul>}
      </section>

      {setup.length > 0 && <section aria-labelledby="cc-setup" data-section="setup">
        {head('setup', setup.length)}
        <ul className={s.grid}>
          {setup.map((f) => <li key={f.key} className={`${s.card} ${s.setupCard}`} data-feature={f.key} data-state={f.state}>
            <div className={s.cardTop}><h3>{f.name}</h3>{badge(f)}</div>
            <p>{f.detail}</p>
            {f.action ? <Link href={f.action.href} prefetch={false} className={s.actionStrong}>{f.action.label} <span aria-hidden="true">→</span></Link> : f.who && <p className={s.who}>{f.who}</p>}
          </li>)}
        </ul>
      </section>}

      {rows.map(([sec, list]) => list.length > 0 && <section key={sec} aria-labelledby={`cc-${sec}`} data-section={sec}>
        {head(sec, list.length)}
        {rowList(list)}
      </section>)}

      <section aria-labelledby="cc-later" data-section="later">
        {head('later', laterRows.length + laterNames.length)}
        {laterRows.length > 0 && rowList(laterRows)}
        <ul className={s.names}>{laterNames.map((name) => <li key={name}>{name}</li>)}</ul>
      </section>
    </div>

    <p className={s.foot}><Link href="/dashboard/settings#features" prefetch={false}>{t('cc.statusPage')}</Link> · {t('cc.checked')}</p>
  </div>;
}
