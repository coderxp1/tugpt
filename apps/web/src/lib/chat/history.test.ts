import { describe, expect, it } from 'vitest';
import { displayTitle, groupThreads, shortTime } from './history';

const now = new Date(2026, 4, 20, 12, 0, 0).getTime();
const at = (d: number, h = 10) => new Date(2026, 4, 20 - d, h, 0, 0).toISOString();

describe('chat history presentation', () => {
  it('groups newest first by day and never drops a thread', () => {
    const t = [
      { id: 'old', title: 'a', updatedAt: at(30) }, { id: 'today', title: 'b', updatedAt: at(0) },
      { id: 'y', title: 'c', updatedAt: at(1) }, { id: 'week', title: 'd', updatedAt: at(4) }, { id: 'bad', title: 'e', updatedAt: 'nope' },
    ];
    const g = groupThreads(t, now);
    expect(g.map((x) => x.label)).toEqual(['Today', 'Yesterday', 'Previous 7 days', 'Earlier']);
    expect(g.flatMap((x) => x.items).map((x) => x.id).sort()).toEqual(['bad', 'old', 'today', 'week', 'y']);
  });
  it('labels a chat without messages honestly', () => {
    expect(displayTitle('New chat')).toBe('Untitled chat'); expect(displayTitle('  ')).toBe('Untitled chat'); expect(displayTitle('Plan Q3')).toBe('Plan Q3');
  });
  it('formats short times', () => {
    expect(shortTime(new Date(now - 20_000).toISOString(), now)).toBe('just now');
    expect(shortTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5 min ago');
    expect(shortTime('x', now)).toBe('');
  });
});
