/**
 * Recent chats, grouped the way people scan them (Today, Yesterday, Previous 7 days, Older) and
 * filtered by the sidebar search. Pure, so it is tested without a DOM and runs on every keystroke.
 *
 * Search covers the chats already loaded for this person (the newest 50, scoped by RLS to their own
 * chats in the active organization). Full-history search needs a server endpoint; see
 * docs/workspace/api-contracts.md (C-2).
 */
import type { Thread } from '@/components/chat/types';

export type ThreadGroupKey = 'today' | 'yesterday' | 'week' | 'older';
export interface ThreadGroup { readonly key: ThreadGroupKey; readonly threads: Thread[] }

const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function groupKey(updatedAt: string, now: Date = new Date()): ThreadGroupKey {
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return 'older';
  const today = startOfDay(now);
  if (t >= today) return 'today';
  if (t >= today - DAY) return 'yesterday';
  if (t >= today - 7 * DAY) return 'week';
  return 'older';
}

/** Case- and accent-insensitive: "camion" finds "Camión". */
export function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

export function filterThreads(threads: readonly Thread[], query: string): Thread[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...threads];
  return threads.filter((t) => { const title = normalize(t.title); return terms.every((q) => title.includes(q)); });
}

const ORDER: readonly ThreadGroupKey[] = ['today', 'yesterday', 'week', 'older'];

/** Keeps the incoming order (newest first) inside each group; empty groups are left out. */
export function groupThreads(threads: readonly Thread[], now: Date = new Date()): ThreadGroup[] {
  const buckets = new Map<ThreadGroupKey, Thread[]>();
  for (const t of threads) {
    const k = groupKey(t.updatedAt, now);
    buckets.set(k, [...(buckets.get(k) ?? []), t]);
  }
  return ORDER.filter((k) => buckets.has(k)).map((key) => ({ key, threads: buckets.get(key)! }));
}
