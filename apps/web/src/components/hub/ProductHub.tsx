/**
 * The TuGPT Dashboard: the product hub every signed-in person lands on.
 *
 * A server component. It owns the frame (atmosphere, top bar, intro and the
 * "what needs you" summary); only the constellation is a client component,
 * because only it reacts to the pointer.
 *
 * The frame is deliberately separate from the tools' `AppShell`. The hub is a
 * place to choose where to go; the tools are places to work. Different jobs,
 * different frames, one product — the same mark, colours and type carry
 * across, and every tool page links back here from its header.
 */

import Link from 'next/link';
import type { Translator } from '@/i18n/types';
import { attentionCount, type ProductView } from '@/lib/hub/products';
import { Constellation } from './Constellation';
import { TuGPTMark } from './glyphs';
import s from './hub.module.css';

export interface ProductHubProps {
  readonly organizationName: string | null;
  readonly email: string | null;
  readonly role: string | null;
  readonly products: readonly ProductView[];
  readonly t: Translator;
}

export function ProductHub({ organizationName, email, role, products, t }: ProductHubProps) {
  const waiting = attentionCount(products);
  const waitingProducts = products.filter((p) => p.state === 'attention');
  const unknown = products.some((p) => p.state === 'unknown');

  return (
    <div className={s.root}>
      <div className={s.atmosphere} aria-hidden="true">
        <div className={s.dust} />
        <div className={s.floor} />
        <div className={s.grain} />
      </div>

      <a href="#hub-main" className={s.skip}>
        {t('shell.skipToContent')}
      </a>

      <header className={s.bar}>
        <div className={s.brand}>
          <Link href="/dashboard" className={s.logo} aria-label={t('hub.home')}>
            <TuGPTMark size={30} />
            <span>tugpt</span>
          </Link>
          <span className={s.org}>
            <span className={s.slash} aria-hidden="true">/</span>
            <span className="sr-only">{t('shell.organizationLabel')}: </span>
            <strong>{organizationName ?? t('shell.organizationUnknown')}</strong>
            {role ? <span aria-hidden="true">· {role}</span> : null}
          </span>
        </div>
        <div className={s.account}>
          {email ? <span className={s.email}>{email}</span> : null}
          <Link href="/auth/logout" prefetch={false} className={s.pill}>
            {t('shell.signOut')}
          </Link>
        </div>
      </header>

      <main id="hub-main" className={s.main}>
        <section className={s.intro} aria-labelledby="hub-title">
          <p className={s.eyebrow}>
            TuGPT / <b>{t('hub.eyebrow')}</b>
          </p>
          <h1 id="hub-title" className={s.title}>
            {t('hub.title.line1')}
            <br />
            <em>{t('hub.title.line2')}</em>
          </h1>
          <p className={s.lede}>{t('hub.lede')}</p>

          <div className={`${s.glass} ${s.pulseCard}`}>
            <div className={s.pulseHead}>
              <p className={s.eyebrow}>{t('hub.pulse.eyebrow')}</p>
            </div>
            <div className={`${s.pulseNumber} ${waiting > 0 ? s.pulseNumberHot : s.pulseNumberCalm}`}>
              {waiting}
            </div>
            <p className={s.pulseText}>
              {waiting > 0 ? t('hub.pulse.some', { count: waiting }) : t('hub.pulse.none')}
              {unknown ? ` ${t('hub.pulse.partial')}` : ''}
            </p>
            {waitingProducts.length > 0 ? (
              <ul className={s.list}>
                {waitingProducts.map((p) => (
                  <li key={p.id}>
                    {p.href ? (
                      <Link href={p.href}>
                        <span>
                          {t(p.titleKey)}
                          {p.metric !== null && p.metricKey ? ` · ${p.metric} ${t(p.metricKey)}` : ''}
                        </span>
                        <span className={s.arrow} aria-hidden="true">↗</span>
                      </Link>
                    ) : (
                      <span className={s.row}>{t(p.titleKey)}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>

        <section aria-labelledby="hub-products-title">
          <h2 id="hub-products-title" className="sr-only">
            {t('hub.products.label')}
          </h2>
          <Constellation products={products} organizationName={organizationName} />
        </section>
      </main>

      <footer className={s.strip}>
        <span>{t('hub.footer.tagline')}</span>
        <span>{t('hub.footer.scope')}</span>
      </footer>
    </div>
  );
}
