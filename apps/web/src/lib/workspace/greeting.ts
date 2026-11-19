/** "Good morning, Clara": the part of the day, and the first name only (never the email). */
export type DayPart = 'morning' | 'afternoon' | 'evening';

export function dayPart(now: Date = new Date()): DayPart {
  const h = now.getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 18) return 'afternoon';
  return 'evening';
}

export function firstName(fullName: string | null | undefined): string | null {
  const first = (fullName ?? '').trim().split(/\s+/)[0];
  return first ? first.slice(0, 40) : null;
}
