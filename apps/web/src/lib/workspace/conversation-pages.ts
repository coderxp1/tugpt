import type { ConversationList, ConversationQuery, WorkspaceClient, WorkspaceResult } from '@/lib/workspace-data/contracts';

/** Load the complete requested list; never derive a cursor from timestamps or IDs. */
export async function conversationPages(api: Pick<WorkspaceClient, 'listConversations'>, query: ConversationQuery): Promise<WorkspaceResult<ConversationList>> {
  const threads = new Map<string, ConversationList['threads'][number]>();
  const seen = new Set<string>();
  let before = query.before;
  if (before !== undefined) seen.add(before);
  for (;;) {
    const r = await api.listConversations({ ...query, before });
    if (!r.ok) return r;
    if (!r.value || !Array.isArray(r.value.threads) || !(r.value.nextCursor === null || typeof r.value.nextCursor === 'string')) {
      return { ok: false, status: 502, error: 'UNEXPECTED_RESPONSE' };
    }
    for (const thread of r.value.threads) threads.set(thread.id, thread);
    const next = r.value.nextCursor;
    if (next === null) return { ok: true, value: { threads: [...threads.values()], nextCursor: null } };
    if (seen.has(next)) return { ok: false, status: 502, error: 'UNEXPECTED_RESPONSE' };
    seen.add(next);
    before = next;
  }
}
