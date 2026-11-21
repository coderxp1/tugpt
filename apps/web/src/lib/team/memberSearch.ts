import { foldText, searchWords } from '@/lib/text/fold';

/** The fields member search reads. Search runs in the browser over the list the server already returned. */
export interface SearchableMember { name: string | null; email: string | null; role: string }

/** Longest query accepted by the search box. */
export const MEMBER_QUERY_MAX = 100;

/**
 * Members whose name, email or role label (as shown, in the viewer's language)
 * contain every word of the query. Case and accents are ignored. A blank query
 * returns everyone, in the original order.
 */
export function filterMembers<T extends SearchableMember>(members: readonly T[], query: string, roleText: (role: string) => string): T[] {
  const words = searchWords(query.slice(0, MEMBER_QUERY_MAX));
  if (words.length === 0) return [...members];
  return members.filter((m) => {
    const hay = foldText(`${m.name ?? ''} ${m.email ?? ''} ${roleText(m.role)}`);
    return words.every((w) => hay.includes(w));
  });
}
