import { describe, expect, it } from 'vitest';
import type { ChatDb, DbQuery, DbResult } from './chat/store';
import { getThread, listThreads } from './chat/store';
import { getGeneration, listGenerations } from './create/store';

/**
 * Defence in depth on top of RLS (covered by supabase/tests/database/create_images.test.sql
 * and workspace_chat.test.sql): every read the dashboard makes for a person's image history
 * and chats carries the organization and, where the data is personal, the user filter.
 */
function recordingDb(result: unknown) {
  const calls: { table: string; filters: Record<string, unknown> }[] = [];
  const db: ChatDb = {
    from(table: string) {
      const filters: Record<string, unknown> = {}; calls.push({ table, filters });
      const done: DbResult = { data: result, error: null };
      const q: DbQuery = {
        select: () => q, eq: (c, v) => { filters[c] = v; return q; }, is: (c, v) => { filters[c] = v; return q; },
        in: (c, v) => { filters[c] = v; return q; }, order: () => q, limit: () => q,
        single: () => Promise.resolve(done), maybeSingle: () => Promise.resolve(done),
        then: (ok, ko) => Promise.resolve(done).then(ok, ko),
      };
      return { select: () => q, insert: () => q, update: () => q };
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
  return { db, calls };
}

const ORG = 'org-a', USER = 'user-a', OTHER = 'img-or-thread-1';

describe('tenant and user scoping of customer reads', () => {
  it('image history list is scoped to organization and owner', async () => {
    const { db, calls } = recordingDb([]);
    await listGenerations(db, ORG, USER);
    expect(calls).toEqual([{ table: 'image_generations', filters: expect.objectContaining({ organization_id: ORG, owner_user_id: USER }) }]);
  });
  it('a single image is looked up by id AND organization AND owner (another person gets null)', async () => {
    const { db, calls } = recordingDb(null);
    expect(await getGeneration(db, ORG, USER, OTHER)).toBeNull();
    expect(calls[0].filters).toEqual(expect.objectContaining({ id: OTHER, organization_id: ORG, owner_user_id: USER }));
  });
  it('chat list is scoped to organization and owner', async () => {
    const { db, calls } = recordingDb([]);
    await listThreads(db, ORG, USER);
    expect(calls[0]).toEqual({ table: 'chat_threads', filters: expect.objectContaining({ organization_id: ORG, owner_user_id: USER }) });
  });
  it('a thread is looked up within the organization and is NOT_FOUND when RLS hides it', async () => {
    const { db, calls } = recordingDb(null);
    await expect(getThread(db, ORG, OTHER)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(calls[0].filters).toEqual(expect.objectContaining({ id: OTHER, organization_id: ORG }));
  });
});
