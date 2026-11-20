'use client';

import Link from 'next/link';
import { useT } from '@/i18n/provider';
import type { Translator } from '@/i18n/types';
import { pickerBlock } from '@/lib/connect-ui/chat-errors';
import s from './chat.module.css';

export interface Capability {
  capabilityKey: string; providerKey: string; providerName: string; description: string; permissionClass: string;
  state: 'connected' | 'requires_connection' | 'disabled_by_policy' | 'not_available';
  /** false when the catalogue lists it but chat has no tool for it on this build. */
  toolAvailable?: boolean;
  /** MCP only: which gate keeps it off (see pickerBlock). */
  unavailableReason?: string;
}

const fold = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * Picker search: every word of the query must appear in the provider name, the
 * description, or the provider/capability key. Accents and case are ignored.
 * Usable apps come first so the listbox can show them as one group.
 */
export function matchCapabilities(all: readonly Capability[], query: string, modelCanUseTools: boolean, t?: Translator): Capability[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const hit = all.filter((c) => {
    const hay = fold(`${c.providerName} ${c.description} ${c.providerKey} ${c.capabilityKey.replace(/[._]/g, ' ')} ${c.capabilityKey}`);
    return words.every((w) => hay.includes(w));
  });
  const ready = hit.filter((c) => pickerBlock(c, modelCanUseTools, t) === null);
  return [...ready, ...hit.filter((c) => !ready.includes(c))];
}

export interface MentionPickerProps {
  id: string;
  matches: readonly Capability[];
  activeIndex: number;
  modelCanUseTools: boolean;
  query: string;
  /** Total apps known to Chat before filtering, to tell "no match" from "none at all". */
  total: number;
  onChoose(c: Capability): void;
}

/** The @ listbox. Unusable apps stay visible with the reason, but cannot be chosen. */
export function MentionPicker({ id, matches, activeIndex, modelCanUseTools, query, total, onChoose }: MentionPickerProps) {
  const t = useT();
  const blocks = matches.map((c) => pickerBlock(c, modelCanUseTools, t));
  const ready = blocks.filter((b) => b === null).length;
  const anyConnected = matches.some((c) => c.state === 'connected' && c.toolAvailable !== false);
  const option = (c: Capability, i: number) => {
    const block = blocks[i];
    return (
      <li key={`${c.providerKey}:${c.capabilityKey}:${c.providerName}:${i}`} id={`${id}-${i}`} role="option" aria-selected={i === activeIndex} aria-disabled={block !== null}
        className={`${s.option} ${i === activeIndex ? s.optionActive : ''} ${block ? s.optionOff : ''}`} data-ready={block === null}
        onMouseDown={(e) => { e.preventDefault(); onChoose(c); }}>
        <strong>{c.providerName}</strong><span>{c.description}</span><em>{block ?? t('chat.picker.connected')}</em>
      </li>
    );
  };
  return (
    <div className={s.pickerWrap}>
      <p className={s.sr} role="status" aria-live="polite" data-testid="picker-count">
        {matches.length === 0 ? t('chat.picker.countNone') : t('chat.picker.count', { count: matches.length, ready })}
      </p>
      <ul id={id} role="listbox" aria-label={t('chat.picker.aria')} className={s.picker}>
        {matches.length === 0 && (
          <li className={s.pickerEmpty} role="presentation" data-testid="picker-empty">
            {total === 0 || query.trim() === '' ? t('chat.picker.noApps') : t('chat.picker.noMatch', { query: query.trim() })}{' '}
            <Link href="/dashboard/connect">{t('chat.openConnect')}</Link>
          </li>
        )}
        {ready > 0 && <li className={s.pickerGroup} role="presentation" aria-hidden="true">{t('chat.picker.ready')}</li>}
        {matches.slice(0, ready).map((c, i) => option(c, i))}
        {matches.length > ready && <li className={s.pickerGroup} role="presentation" aria-hidden="true">{t('chat.picker.blocked')}</li>}
        {matches.slice(ready).map((c, i) => option(c, i + ready))}
        {anyConnected && !modelCanUseTools && (
          <li className={s.muted} role="presentation">{t('chat.picker.modelOff')}</li>
        )}
        <li className={s.pickerHelp} role="presentation" aria-hidden="true">{t('chat.picker.help')}</li>
      </ul>
    </div>
  );
}
