import { describe, expect, it } from 'vitest';
import { filterThreads, groupKey, groupThreads, normalize } from './group-threads';

const now = new Date(2026, 10, 15, 14, 0, 0);
const at = (y: number, m: number, d: number, h = 9) => new Date(y, m, d, h).toISOString();
const th = (id: string, title: string, updatedAt: string) => ({ id, title, modelKey: 'scout', updatedAt });

describe('groupKey', () => {
  it('buckets by calendar day in local time', () => {
    expect(groupKey(at(2026, 10, 15, 0), now)).toBe('today');
    expect(groupKey(at(2026, 10, 14, 23), now)).toBe('yesterday');
    expect(groupKey(at(2026, 10, 9), now)).toBe('week');
    expect(groupKey(at(2026, 10, 1), now)).toBe('older');
  });
  it('treats unreadable dates as older instead of throwing', () => {
    expect(groupKey('not a date', now)).toBe('older');
  });
});

describe('normalize / filterThreads', () => {
  const list = [th('1', 'Camión route audit', at(2026, 10, 15)), th('2', 'Q4 Pricing notes', at(2026, 10, 14)), th('3', 'Pricing for camiones', at(2026, 10, 1))];
  it('is case- and accent-insensitive', () => {
    expect(normalize('  CAMIÓN  ')).toBe('camion');
    expect(filterThreads(list, 'camion').map((t) => t.id)).toEqual(['1', '3']);
  });
  it('requires every word, in any order', () => {
    expect(filterThreads(list, 'camiones pricing').map((t) => t.id)).toEqual(['3']);
  });
  it('returns everything (a copy) for an empty query', () => {
    const out = filterThreads(list, '   ');
    expect(out).toEqual(list);
    expect(out).not.toBe(list);
  });
});

describe('groupThreads', () => {
  it('keeps order inside groups and leaves out empty groups', () => {
    const list = [th('a', 'A', at(2026, 10, 15, 12)), th('b', 'B', at(2026, 10, 15, 8)), th('c', 'C', at(2026, 9, 1))];
    expect(groupThreads(list, now).map((g) => [g.key, g.threads.map((t) => t.id)])).toEqual([['today', ['a', 'b']], ['older', ['c']]]);
  });
  it('is empty for no threads', () => {
    expect(groupThreads([], now)).toEqual([]);
  });
});
