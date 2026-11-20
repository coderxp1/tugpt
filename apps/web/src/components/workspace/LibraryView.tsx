'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useT } from '@/i18n/provider';
import { normalize } from '@/lib/workspace/group-threads';
import { STARTERS } from '@/lib/workspace/starters';
import { starterHref } from '@/lib/workspace/routes';
import { FileManager } from './FileManager';
import { Collections } from './Collections';
import { Icon } from './icons';
import s from './pages.module.css';

interface KnowledgeEntry { id: string; question: string; answer: string; enabled: boolean }
type Load = { state: 'loading' } | { state: 'ready'; entries: KnowledgeEntry[] } | { state: 'unavailable'; message: string } | { state: 'failed' };

export interface LibraryViewProps {
  /** Owner or admin: may manage knowledge in the Dashboard (the API checks the role again). */
  readonly canManage: boolean;
  readonly role?: string;
}

/**
 * Library: the organization's knowledge (read-only here; GET /api/v1/knowledge, RLS-scoped to the
 * active organization, members read) and TuGPT's starter prompts. Editing knowledge stays in the
 * Dashboard, which is the administration surface.
 */
export function LibraryView({ canManage, role }: LibraryViewProps) {
  const t = useT();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [query, setQuery] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    fetch('/api/v1/knowledge', { cache: 'no-store' })
      .then(async (r) => {
        const body = await r.json().catch(() => ({})) as { entries?: KnowledgeEntry[]; error?: { code?: string; message?: string } };
        if (!current) return;
        if (r.ok && Array.isArray(body.entries)) setLoad({ state: 'ready', entries: body.entries });
        else if (r.status === 403 || r.status === 404 || body.error?.code === 'FEATURE_UNAVAILABLE') setLoad({ state: 'unavailable', message: body.error?.message ?? '' });
        else setLoad({ state: 'failed' });
      })
      .catch(() => { if (current) setLoad({ state: 'failed' }); });
    return () => { current = false; };
  }, [attempt]);

  const shown = useMemo(() => {
    if (load.state !== 'ready') return [];
    const q = normalize(query);
    return q ? load.entries.filter((e) => normalize(`${e.question} ${e.answer}`).includes(q)) : load.entries;
  }, [load, query]);

  return (
    <div className={s.page}>
      <div className={s.inner}>
        <header className={s.head}>
          <p className={s.eyebrow}>{t('workspace.area.library')}</p>
          <h1>{t('workspace.library.title')}</h1>
          <p>{t('workspace.library.intro')}</p>
        </header>

        <Collections />
        <FileManager role={role} />

        <section className={s.section} aria-labelledby="lib-starters">
          <div className={s.sectionHead}><h2 id="lib-starters">{t('workspace.library.starters')}</h2><p>{t('workspace.library.startersNote')}</p></div>
          <ul className={s.grid}>
            {STARTERS.map((st) => (
              <li key={st.key} className={s.card}>
                <div className={s.cardHead}>
                  <span className={`${s.mark} ${s.markMuted}`} aria-hidden="true"><Icon name={st.icon} /></span>
                  <div><h3>{t(st.titleKey)}</h3><p>{t(st.promptKey)}</p></div>
                </div>
                <div className={s.actions}>
                  <Link href={starterHref(st.key)} prefetch={false} className={s.secondary}>{t('workspace.library.use')}<span className={s.sr}>: {t(st.titleKey)}</span></Link>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className={s.section} aria-labelledby="lib-knowledge">
          <div className={s.sectionHead}>
            <h2 id="lib-knowledge">{t('workspace.library.knowledge')}</h2>
            {canManage && <Link href="/dashboard/knowledge" prefetch={false} className={s.secondary}>{t('workspace.library.manage')}</Link>}
          </div>
          <p className={s.muted}>{t('workspace.library.knowledgeNote')}</p>
          {load.state === 'loading' && <div aria-busy="true" aria-label={t('workspace.library.loading')} style={{ display: 'grid', gap: 8 }}><div className={s.skeleton} /><div className={s.skeleton} /></div>}
          {load.state === 'failed' && <p className={s.error} role="alert">{t('workspace.library.failed')} <button type="button" className={s.secondary} onClick={() => { setLoad({ state: 'loading' }); setAttempt((n) => n + 1); }}>{t('workspace.tryAgain')}</button></p>}
          {load.state === 'unavailable' && <div className={s.notice}><strong>{t('workspace.library.unavailable')}</strong>{load.message && <p>{load.message}</p>}</div>}
          {load.state === 'ready' && (load.entries.length === 0
            ? <div className={s.notice}><strong>{t('workspace.library.empty')}</strong><p>{canManage ? t('workspace.library.emptyAdmin') : t('workspace.library.emptyMember')}</p></div>
            : <>
                <div className={s.searchRow}><Icon name="search" size={16} />
                  <label htmlFor="lib-search" className={s.sr}>{t('workspace.library.search')}</label>
                  <input id="lib-search" type="search" value={query} placeholder={t('workspace.library.search')} onChange={(e) => setQuery(e.target.value)} />
                </div>
                <p className={s.sr} role="status">{t('workspace.library.count', { count: shown.length })}</p>
                {shown.length === 0
                  ? <p className={s.muted}>{t('workspace.noMatches', { query: query.trim() })}</p>
                  : <ul className={s.list}>{shown.map((e) => (
                      <li key={e.id} className={s.entry}>
                        <details>
                          <summary>{e.question}{!e.enabled && <span className={s.off}>{t('workspace.library.disabled')}</span>}</summary>
                          <p>{e.answer}</p>
                        </details>
                      </li>
                    ))}</ul>}
              </>)}
        </section>
      </div>
    </div>
  );
}
