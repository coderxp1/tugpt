/** Presentation helpers for the chat history list. Pure; uses only data the thread list already returns. */
import { createTranslator } from '@/i18n';
import type { Translator } from '@/i18n/types';

const EN = createTranslator('en');

export interface HistoryThread { id: string; title: string; updatedAt: string }
export type HistoryGroupKey = 'today' | 'yesterday' | 'week' | 'earlier';
export interface HistoryGroup<T extends HistoryThread> { key: HistoryGroupKey; label: string; items: T[] }

const DAY = 86_400_000;
const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Server default title for a chat that has no first message yet. */
export const UNTITLED = 'New chat';
export const displayTitle = (title: string, t: Translator = EN) => (title.trim() === '' || title === UNTITLED ? t('chat.hist.untitled') : title);

/** Groups newest first into Today / Yesterday / Previous 7 days / Earlier. Invalid dates go to Earlier, never dropped. */
export function groupThreads<T extends HistoryThread>(threads: readonly T[], now = Date.now(), t: Translator = EN): HistoryGroup<T>[] {
  const today = startOfDay(now);
  const keyOf = (iso: string): HistoryGroupKey => {
    const v = Date.parse(iso);
    if (Number.isNaN(v)) return 'earlier';
    if (v >= today) return 'today';
    if (v >= today - DAY) return 'yesterday';
    if (v >= today - 7 * DAY) return 'week';
    return 'earlier';
  };
  const order: HistoryGroupKey[] = ['today', 'yesterday', 'week', 'earlier'];
  const sorted = [...threads].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  return order.map((k) => ({ key: k, label: t(`chat.hist.${k}`), items: sorted.filter((x) => keyOf(x.updatedAt) === k) })).filter((g) => g.items.length > 0);
}

/** "just now", "5 min ago", "14:20", "Mon", "3 Mar", in the reader's language. */
export function shortTime(iso: string, now = Date.now(), t: Translator = EN): string {
  const v = Date.parse(iso);
  if (Number.isNaN(v)) return '';
  const diff = now - v;
  if (diff < 60_000 && diff > -60_000) return t('chat.hist.justNow');
  if (diff > 0 && diff < 3_600_000) return t('chat.hist.minAgo', { n: Math.floor(diff / 60_000) });
  const d = new Date(v);
  const loc = t.locale === 'en' ? 'en-GB' : t.locale;
  if (v >= startOfDay(now)) return d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  if (v >= startOfDay(now) - 7 * DAY) return d.toLocaleDateString(loc, { weekday: 'short' });
  return d.toLocaleDateString(loc, { day: 'numeric', month: 'short' });
}
