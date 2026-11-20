'use client';
import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/provider';
import { capabilityViews, groupText, GROUPS } from '@/lib/hub/capabilities';
import type { ProductView } from '@/lib/hub/products';
import { isUsable, stateLabel, type FeatureKey, type FeatureState } from '@/lib/hub/features';
import { Glyph } from './glyphs';
import s from './reference.module.css';

export function Overview({ products, hasOrganization, features }: { products: readonly ProductView[]; hasOrganization: boolean; features?: Partial<Record<FeatureKey, FeatureState>> }) {
  const t = useT();
  const [search, setSearch] = useState('');
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  useEffect(() => {
    const reset = () => setSearch('');
    window.addEventListener('tugpt:clear-capability-search', reset);
    return () => window.removeEventListener('tugpt:clear-capability-search', reset);
  }, []);
  const q = search.trim().toLocaleLowerCase(t.locale);
  const capabilities = capabilityViews(products, t);
  const matches = capabilities.filter(c => [c.title, c.description, c.area, groupText(c.group, t).title].join(' ').toLocaleLowerCase(t.locale).includes(q));
  const waiting = products.filter(p => p.state === 'attention' && p.href && (!p.featureAccess || p.featureAccess === 'enabled'));
  const unknown = products.some(p => p.state === 'unknown' || p.featureAccess === 'unknown');
  return <>
    <div className={s.heading}>
      <div><p className={s.eyebrow}>{t('overview.eyebrow')}</p><h1>{t('overview.title')}</h1><p>{t('overview.lead')}</p></div>
      <div className={s.headingNote}>{t('overview.headingNote')}</div>
    </div>
    <section className={s.hero} aria-labelledby="hero-title">
      <div className={s.heroCopy}><span className={s.tag}>{t('overview.tag')}</span><h2 id="hero-title">{t('overview.heroTitle1')}<br />{t('overview.heroTitle2')}</h2><p>{t('overview.heroBody')}</p>
        <div className={s.heroActions}><Link className={s.primary} href="/workspace" prefetch={false}>{t('overview.start')} <span aria-hidden="true">→</span></Link><a className={s.heroLink} href="#platform">{t('overview.explore')}</a></div>
      </div>
      <div className={s.heroArt} aria-hidden="true"><div className={s.orbit} />
        <div className={`${s.floatCard} ${s.one}`}><span className={s.floatIcon}><Glyph name="spark" /></span><div>{t('overview.float1')}<small>{t('overview.float1s')}</small></div></div>
        <div className={`${s.floatCard} ${s.two}`}><span className={s.floatIcon}><Glyph name="chat" /></span><div>{t('overview.float2')}<small>{t('overview.float2s')}</small></div></div>
      </div>
    </section>
    <div className={s.activity} aria-label={t('overview.attention')} aria-busy={pending}>
      <div><strong>{t('overview.attention')}</strong><span className={s.sr}>: </span><span>{!hasOrganization ? t('overview.att.noOrg') : unknown ? t('overview.att.unknown') : waiting.length ? t('overview.att.waiting') : t('overview.att.none')}</span>
        {waiting.length > 0 && <div className={s.attentionLinks}>{waiting.map(p => <Link key={p.id} href={p.href!} prefetch={false}>{t(p.titleKey)}{p.metric !== null && p.metricKey ? ` · ${p.metric} ${t(p.metricKey)}` : ` · ${t('overview.reconnect')}`} ↗</Link>)}</div>}
      </div>
      <button className={s.refresh} type="button" disabled={pending} onClick={() => startTransition(() => router.refresh())}>{pending ? t('overview.refreshing') : t('overview.refresh')}</button>
      <span className={s.sr} role="status">{pending ? t('overview.refreshingSr') : ''}</span>
    </div>
    <div className={s.sectionHead} id="platform"><div><p className={s.eyebrow}>{t('overview.sectEyebrow')}</p><h2>{t('overview.sectTitle')}</h2><p>{t('overview.sectLead')}</p></div>
      <label className={s.search}><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg><span className={s.sr}>{t('overview.search')}</span><input type="search" placeholder={t('overview.searchPh')} value={search} onChange={e => setSearch(e.target.value)} autoComplete="off" /></label>
    </div>
    <div className={s.groups} role="list" aria-label={t('overview.products')}>
      {GROUPS.map((g, i) => {
        const entries = matches.filter(c => c.group === g.name);
        return <section key={g.name} role="listitem" className={`${s.group} ${s[g.name.toLowerCase()]}`} id={`group-${g.name}`} aria-labelledby={`heading-${g.name}`} hidden={!entries.length}>
          <div className={s.groupHead}><div><h3 id={`heading-${g.name}`}>{groupText(g.name, t).title}</h3><p>{groupText(g.name, t).sub}</p></div><span className={s.groupNumber}>0{i + 1}</span></div>
          <div className={s.items} role="list" aria-labelledby={`heading-${g.name}`}>{entries.map(c => {
            const p = c.productView;
            const fs = c.feature ? features?.[c.feature] : undefined;
            // Product cards keep their destination (the page explains a disabled state); feature-only cards link only while usable.
            const href = !hasOrganization ? null : p?.href ?? (c.href && isUsable(fs) ? c.href : null);
            const base = p?.state === 'held' ? t('hub.state.held') : !href ? c.product && !hasOrganization ? t('overview.st.membership') : fs && fs !== 'not_implemented' ? stateLabel(fs, t) : t('overview.st.notYet') : p?.featureAccess === 'disabled' || fs === 'disabled' ? t('overview.st.notEnabled') : p?.featureAccess === 'unknown' ? t('overview.st.unknownAccess') : p?.state === 'unknown' ? t('overview.st.activityUnavailable') : p?.state === 'attention' ? t('overview.st.attention') : c.id === 'calendar' ? p?.state === 'connected' ? t('overview.st.connected') : t('overview.st.setup') : fs === 'partial' ? stateLabel('partial', t) : t('overview.st.available');
            // Counts are shown only for features that are actually on; a disabled feature never shows "0 open".
            const showMetric = href && p?.metric !== null && p?.metric !== undefined && p.metricKey && p.featureAccess !== 'disabled' && p.featureAccess !== 'unknown' && fs !== 'disabled';
            const status = base;
            const body = <><span className={s.box}><Glyph name={c.glyph} /></span><span className={s.itemText}><span className={s.itemName}>{c.title}</span><span className={s.itemDesc}>{c.description}</span><span className={`${s.itemStatus} ${href ? s.available : ''}`}>{status}{showMetric ? ` · ${p!.metric} ${t(p!.metricKey!)}` : ''}</span></span>{href && <span className={s.itemArrow} aria-hidden="true">↗</span>}</>;
            return <div key={c.id} role="listitem" data-capability={c.id} data-blueprint-area={c.area}>
              {href ? <Link prefetch={false} href={href} className={s.item}>{body}</Link> : <div className={`${s.item} ${s.planned}`}>{body}</div>}
              {c.note && <p className={s.scopeNote}>{c.note}</p>}
            </div>;
          })}</div>
        </section>;
      })}
      {!matches.length && <div className={s.empty} role="status">{t('overview.empty')}<button type="button" onClick={() => setSearch('')}>{t('overview.clear')}</button></div>}
    </div>
    <div className={s.bottomNote}><span><strong>{t('overview.bottomStrong')}</strong> {t('overview.bottomBody')}</span><Link href="/dashboard/settings#features" prefetch={false}>{t('overview.bottomLink')}</Link></div>
  </>;
}
