'use client';

import Link from 'next/link';
import { useT } from '@/i18n/provider';
import type { MessageKey } from '@/i18n/types';
import { Icon } from '@/components/workspace/icons';
import { dayPart } from '@/lib/workspace/greeting';
import { STARTERS } from '@/lib/workspace/starters';
import { WORKSPACE_IMAGES, WORKSPACE_LIBRARY } from '@/lib/workspace/routes';
import s from './chat.module.css';

const GREETING: Record<ReturnType<typeof dayPart>, { named: MessageKey; plain: MessageKey }> = {
  morning: { named: 'workspace.greeting.morningName', plain: 'workspace.greeting.morning' },
  afternoon: { named: 'workspace.greeting.afternoonName', plain: 'workspace.greeting.afternoon' },
  evening: { named: 'workspace.greeting.eveningName', plain: 'workspace.greeting.evening' },
};

/** The greeting above the composer of a new chat. The part of the day is the browser's. */
export function Greeting({ name }: { readonly name: string | null }) {
  const t = useT();
  const g = GREETING[dayPart()];
  return (
    <div className={s.greeting}>
      <span className={s.greetMark} aria-hidden="true"><Icon name="sparkle" size={22} /></span>
      {/* The server renders in UTC, the browser in local time: the words may differ once, by design. */}
      <h2 suppressHydrationWarning>{name ? t(g.named, { name }) : t(g.plain)}</h2>
      <p>{t('workspace.greeting.sub')}</p>
    </div>
  );
}

/** Starters under the composer of a new chat: fill the box (never send), or open Images. */
export function Starters({ onPick, disabled }: { readonly onPick: (text: string) => void; readonly disabled: boolean }) {
  const t = useT();
  return (
    <section className={s.starters} aria-label={t('workspace.starters.label')}>
      <ul>
        {STARTERS.slice(0, 4).map((st) => (
          <li key={st.key}>
            <button type="button" className={s.starter} disabled={disabled} onClick={() => onPick(t(st.promptKey))}>
              <Icon name={st.icon} size={18} /><span>{t(st.titleKey)}</span>
            </button>
          </li>
        ))}
        <li>
          <Link href={WORKSPACE_IMAGES} prefetch={false} className={s.starter}><Icon name="images" size={18} /><span>{t('workspace.starters.image')}</span></Link>
        </li>
      </ul>
      <Link href={WORKSPACE_LIBRARY} prefetch={false} className={s.moreStarters}>{t('workspace.starters.more')}</Link>
    </section>
  );
}
