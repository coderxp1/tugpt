/** Presentation helpers for the chat history list. Pure; uses only data the thread list already returns. */
export interface HistoryThread { id: string; title: string; updatedAt: string }
export interface HistoryGroup<T extends HistoryThread> { label: string; items: T[] }

const DAY = 86_400_000;
const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Server default title for a chat that has no first message yet. */
export const UNTITLED = 'New chat';
export const displayTitle = (title: string) => (title.trim() === '' || title === UNTITLED ? 'Untitled chat' : title);

/** Groups newest first into Today / Yesterday / Previous 7 days / Earlier. Invalid dates go to Earlier, never dropped. */
export function groupThreads<T extends HistoryThread>(threads: readonly T[], now = Date.now()): HistoryGroup<T>[] {
  const today = startOfDay(now);
  const label = (iso: string) => {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return 'Earlier';
    if (t >= today) return 'Today';
    if (t >= today - DAY) return 'Yesterday';
    if (t >= today - 7 * DAY) return 'Previous 7 days';
    return 'Earlier';
  };
  const order = ['Today', 'Yesterday', 'Previous 7 days', 'Earlier'];
  const sorted = [...threads].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  return order.map((l) => ({ label: l, items: sorted.filter((t) => label(t.updatedAt) === l) })).filter((g) => g.items.length > 0);
}

/** "just now", "5 min ago", "14:20", "Mon", "3 Mar" — short and locale-neutral. */
export function shortTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = now - t;
  if (diff < 60_000 && diff > -60_000) return 'just now';
  if (diff > 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  const d = new Date(t);
  if (t >= startOfDay(now)) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (t >= startOfDay(now) - 7 * DAY) return d.toLocaleDateString('en-GB', { weekday: 'short' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
