'use client';
import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createTranslator } from '@/i18n';
import { capabilityViews, GROUPS } from '@/lib/hub/capabilities';
import type { ProductView } from '@/lib/hub/products';
import { isUsable, STATE_LABEL, type FeatureKey, type FeatureState } from '@/lib/hub/features';
import { Glyph } from './glyphs';
import s from './reference.module.css';

const t = createTranslator('en');
export function Overview({ products, hasOrganization, features }: { products: readonly ProductView[]; hasOrganization: boolean; features?: Partial<Record<FeatureKey, FeatureState>> }) {
  const [search, setSearch] = useState('');
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  useEffect(() => {
    const reset = () => setSearch('');
    window.addEventListener('tugpt:clear-capability-search', reset);
    return () => window.removeEventListener('tugpt:clear-capability-search', reset);
  }, []);
  const q = search.trim().toLowerCase();
  const capabilities = capabilityViews(products);
  const matches = capabilities.filter(c => [c.title, c.description, c.area, c.group].join(' ').toLowerCase().includes(q));
  const waiting = products.filter(p => p.state === 'attention' && p.href && (!p.featureAccess || p.featureAccess === 'enabled'));
  const unknown = products.some(p => p.state === 'unknown' || p.featureAccess === 'unknown');
  return <>
    <div className={s.heading}>
      <div><p className={s.eyebrow}>Your TuGPT platform</p><h1>Good to have you here.</h1><p>Everything your business needs to work smarter, together.</p></div>
      <div className={s.headingNote}>One platform. More possibilities. ✳</div>
    </div>
    <section className={s.hero} aria-labelledby="hero-title">
      <div className={s.heroCopy}><span className={s.tag}>Your connected platform</span><h2 id="hero-title">Big ideas start<br />right here.</h2><p>Ask TuGPT anything in Chat, on private models running on TuGPT’s own EU GPU. Your chats are saved and only you can see them.</p>
        <div className={s.heroActions}><Link className={s.primary} href="/workspace" prefetch={false}>Start a chat <span aria-hidden="true">→</span></Link><a className={s.heroLink} href="#platform">Explore your platform ↘</a></div>
      </div>
      <div className={s.heroArt} aria-hidden="true"><div className={s.orbit} />
        <div className={`${s.floatCard} ${s.one}`}><span className={s.floatIcon}><Glyph name="spark" /></span><div>Ideas in motion<small>Powered by your context</small></div></div>
        <div className={`${s.floatCard} ${s.two}`}><span className={s.floatIcon}><Glyph name="chat" /></span><div>Better together<small>One connected platform</small></div></div>
      </div>
    </section>
    <div className={s.activity} aria-label="Needs your attention" aria-busy={pending}>
      <div><strong>Needs your attention</strong><span className={s.sr}>: </span><span>{!hasOrganization ? 'Organization unavailable. Capabilities require an active membership.' : unknown ? 'Some activity could not be read. Refresh to try again.' : waiting.length ? 'These items are waiting for you.' : 'Nothing is waiting for you right now.'}</span>
        {waiting.length > 0 && <div className={s.attentionLinks}>{waiting.map(p => <Link key={p.id} href={p.href!} prefetch={false}>{t(p.titleKey)}{p.metric !== null && p.metricKey ? ` · ${p.metric} ${t(p.metricKey)}` : ' · Reconnect'} ↗</Link>)}</div>}
      </div>
      <button className={s.refresh} type="button" disabled={pending} onClick={() => startTransition(() => router.refresh())}>{pending ? 'Refreshing…' : 'Refresh activity'}</button>
      <span className={s.sr} role="status">{pending ? 'Refreshing activity' : ''}</span>
    </div>
    <div className={s.sectionHead} id="platform"><div><p className={s.eyebrow}>Made to work together</p><h2>Explore your platform.</h2><p>From the first conversation to the work that follows.</p></div>
      <label className={s.search}><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg><span className={s.sr}>Search capabilities</span><input type="search" placeholder="Find a capability" value={search} onChange={e => setSearch(e.target.value)} autoComplete="off" /></label>
    </div>
    <div className={s.groups} role="list" aria-label="TuGPT products">
      {GROUPS.map((g, i) => {
        const entries = matches.filter(c => c.group === g.name);
        return <section key={g.name} role="listitem" className={`${s.group} ${s[g.name.toLowerCase()]}`} id={`group-${g.name}`} aria-labelledby={`heading-${g.name}`} hidden={!entries.length}>
          <div className={s.groupHead}><div><h3 id={`heading-${g.name}`}>{g.name}</h3><p>{g.sub}</p></div><span className={s.groupNumber}>0{i + 1}</span></div>
          <div className={s.items} role="list" aria-labelledby={`heading-${g.name}`}>{entries.map(c => {
            const p = c.productView;
            const fs = c.feature ? features?.[c.feature] : undefined;
            // Product cards keep their destination (the page explains a disabled state); feature-only cards link only while usable.
            const href = !hasOrganization ? null : p?.href ?? (c.href && isUsable(fs) ? c.href : null);
            const base = p?.state === 'held' ? t('hub.state.held') : !href ? c.product && !hasOrganization ? 'Membership required' : fs && fs !== 'not_implemented' ? STATE_LABEL[fs] : 'Not yet available' : p?.featureAccess === 'disabled' || fs === 'disabled' ? 'Not enabled for this organization' : p?.featureAccess === 'unknown' ? 'Availability unknown' : p?.state === 'unknown' ? 'Activity unavailable' : p?.state === 'attention' ? 'Needs attention' : c.id === 'calendar' ? p?.state === 'connected' ? 'Connected' : 'Setup required' : fs === 'partial' ? STATE_LABEL.partial : 'Available';
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
      {!matches.length && <div className={s.empty} role="status">No capabilities found. Try another search.<button type="button" onClick={() => setSearch('')}>Clear search</button></div>}
    </div>
    <div className={s.bottomNote}><span><strong>What you see is what you can use.</strong> Each status shows what is switched on for your organization today.</span><Link href="/dashboard/settings#features" prefetch={false}>See all feature statuses</Link></div>
  </>;
}
