'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import s from '@/components/connect/connect.module.css';
import { useT } from '@/i18n/provider';
import { localeCookie, SUPPORTED_LOCALES } from '@/i18n';
import type { Locale } from '@/i18n/types';

/** Per-person Dashboard language, stored in a browser cookie only (no account or database change). */
export function LanguagePreference() {
  const t = useT();
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState<Locale>(t.locale);
  const [busy, setBusy] = useState(false);
  function apply() {
    setBusy(true);
    document.cookie = localeCookie(value);
    router.refresh();
  }
  return (
    <section className={s.card} aria-labelledby="lang-h" id="language" data-testid="language-preference">
      <h2 id="lang-h">{t('settings.lang.title')}</h2>
      <p className={s.next}>{t('settings.lang.lead')}</p>
      <div className={s.actionsRow}>
        <label htmlFor={id} className={s.sr}>{t('settings.lang.label')}</label>
        <select id={id} className={s.select} value={value} onChange={(e) => setValue(e.target.value as Locale)}>
          {(['en', 'es'] as const).filter((l) => (SUPPORTED_LOCALES as readonly string[]).includes(l)).map((l) => <option key={l} value={l} lang={l}>{t(`settings.lang.${l}`)}</option>)}
        </select>
        <button type="button" className={s.primary} onClick={apply} disabled={busy || value === t.locale}>{busy ? t('settings.lang.saving') : t('settings.lang.save')}</button>
      </div>
      <p className={s.muted}>{t('settings.lang.note')}</p>
    </section>
  );
}
