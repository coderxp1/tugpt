import { describe, expect, it } from 'vitest';
import {
  appendMessage, authorizeCitations, ChatStoreError, getThread, listMessages, MAX_CITATION_SNIPPET, parseCitations,
  type ChatDb, type DbQuery, type DbResult, type MessageCitation, type StoredMessage,
} from './store';

const ORG = 'a4a00000-0000-4000-8000-00000000000a';
const THREAD = 'a4700000-0000-4000-8000-0000000000a2';
const AGENT = 'a4900000-0000-4000-8000-000000000009';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DOC1 = id(1), DOC2 = id(2), COL = id(10), COL_OTHER = id(11), FILE1 = id(21), FILE2 = id(22);

const cite = (n: number, documentId: string, fileId: string, collectionId = COL): MessageCitation =>
  ({ n, documentId, collectionId, fileId, title: `doc ${n}.md`, ordinal: n - 1, snippet: `excerpt ${n}` });

type Call = { table: string; op: string; cols?: string; values?: Record<string, unknown>; eq: Record<string, unknown>; in: Record<string, readonly unknown[]> };

/** Records every query; `tables` answers selects, `fail` makes a table error out. */
function fakeDb(tables: Record<string, unknown>, fail: Set<string> = new Set()) {
  const calls: Call[] = [];
  const db: ChatDb = {
    from(table: string) {
      const start = (op: string, values?: Record<string, unknown>) => {
        const c: Call = { table, op, values, eq: {}, in: {} }; calls.push(c);
        const result = (): DbResult => (fail.has(table) ? { data: null, error: { message: 'down' } }
          : { data: op === 'insert' ? { ...values, id: id(99), created_at: '2026-11-20T10:00:00Z' } : (table in tables ? tables[table] : []), error: null });
        const q: DbQuery = {
          select: (cols) => { c.cols = cols; return q; }, eq: (k, v) => { c.eq[k] = v; return q; }, is: (k, v) => { c.eq[k] = v; return q; },
          in: (k, vs) => { c.in[k] = vs; return q; }, order: () => q, limit: () => q,
          single: () => Promise.resolve(result()), maybeSingle: () => Promise.resolve(result()),
          then: (ok, ko) => Promise.resolve(result()).then(ok, ko),
        };
        return q;
      };
      return { select: (cols: string) => start('select').select(cols), insert: (v: object) => start('insert', v as Record<string, unknown>), update: (v: object) => start('update', v as Record<string, unknown>) };
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
  return { db, calls };
}

const row = (over: Record<string, unknown>) => ({
  id: id(50), role: 'assistant', content: 'Answer [1]', created_at: '2026-11-20T10:00:00Z', status: 'complete', mentions: [], capability_key: null,
  citations: [], knowledge_unavailable: false, ...over,
});

describe('chat store: thread agent identity (Q-9)', () => {
  it('returns agentId from the saved thread and null for plain chat', async () => {
    const t = { id: THREAD, title: 'T', model_key: 'it-model', updated_at: '2026-11-20T10:00:00Z' };
    const a = fakeDb({ chat_threads: { ...t, agent_id: AGENT } });
    expect(await getThread(a.db, ORG, THREAD)).toEqual({ id: THREAD, title: 'T', modelKey: 'it-model', updatedAt: '2026-11-20T10:00:00Z', agentId: AGENT });
    expect(a.calls[0].cols).toContain('agent_id');
    expect(a.calls[0].eq).toMatchObject({ id: THREAD, organization_id: ORG, archived_at: null });
    expect((await getThread(fakeDb({ chat_threads: { ...t, agent_id: null } }).db, ORG, THREAD)).agentId).toBeNull();
    await expect(getThread(fakeDb({ chat_threads: null }).db, ORG, THREAD)).rejects.toEqual(new ChatStoreError('NOT_FOUND'));
  });
});

describe('chat store: citations (Q-9)', () => {
  it('parses exactly the contract fields and drops malformed entries', () => {
    const good = cite(1, DOC1, FILE1);
    expect(parseCitations([good, { ...good, extra: 'x' }])).toEqual([good, good]); // extra keys never leave the store
    expect(parseCitations([{ ...good, n: 0 }, { ...good, ordinal: -1 }, { ...good, documentId: 'nope' }, { ...good, title: 1 }, null, 'x'])).toEqual([]);
    expect(parseCitations('not-an-array')).toEqual([]);
    expect(parseCitations(Array.from({ length: 30 }, (_, i) => cite(i + 1, DOC1, FILE1)))).toHaveLength(20);
  });

  it('restores citations and knowledgeUnavailable on assistant messages; user/tool messages and plain chat have none', async () => {
    const { db, calls } = fakeDb({
      chat_messages: [
        row({ id: id(51), role: 'user', content: 'Q', citations: [cite(1, DOC1, FILE1)], knowledge_unavailable: true }), // impossible in the DB; ignored anyway
        row({ id: id(52), citations: [cite(1, DOC1, FILE1), cite(2, DOC2, FILE2)] }),
        row({ id: id(53), citations: [], knowledge_unavailable: true }),
      ],
      knowledge_documents: [{ id: DOC1, collection_id: COL, file_id: FILE1 }, { id: DOC2, collection_id: COL, file_id: FILE2 }],
    });
    const m = await listMessages(db, ORG, THREAD);
    expect(m.map((x) => [x.role, x.citations.length, x.knowledgeUnavailable])).toEqual([['user', 0, false], ['assistant', 2, false], ['assistant', 0, true]]);
    expect(m[1].citations).toEqual([cite(1, DOC1, FILE1), cite(2, DOC2, FILE2)]);
    expect(calls[0].cols).toContain('citations');
    expect(calls[0].cols).toContain('knowledge_unavailable');
    // The re-check runs under the same (caller's) client, scoped to the tenant.
    expect(calls[1]).toMatchObject({ table: 'knowledge_documents', eq: { organization_id: ORG }, in: { id: [DOC1, DOC2] } });

    const plain = fakeDb({ chat_messages: [row({ role: 'user' }), row({})] });
    const p = await listMessages(plain.db, ORG, THREAD);
    expect(p.every((x) => x.citations.length === 0 && x.knowledgeUnavailable === false)).toBe(true);
    expect(plain.calls.map((c) => c.table)).toEqual(['chat_messages']); // no extra query without citations
  });

  it('omits citations whose document the reader can no longer read, or that moved; the rest keep their n', async () => {
    const msg = (citations: MessageCitation[]): StoredMessage => ({
      id: id(60), role: 'assistant', content: 'a [1] b [2] c [3]', createdAt: 'x', status: 'complete', mentions: [], capabilityKey: null, citations, knowledgeUnavailable: false,
    });
    const DOC3 = id(3);
    const { db } = fakeDb({ knowledge_documents: [{ id: DOC1, collection_id: COL, file_id: FILE1 }, { id: DOC3, collection_id: COL_OTHER, file_id: FILE2 }] });
    const [out] = await authorizeCitations(db, ORG, [msg([cite(1, DOC1, FILE1), cite(2, DOC2, FILE2), cite(3, DOC3, FILE2)])]);
    expect(out.citations).toEqual([cite(1, DOC1, FILE1)]); // DOC2 unreadable; DOC3 now in another collection
    const none = await authorizeCitations(fakeDb({ knowledge_documents: [] }).db, ORG, [msg([cite(1, DOC1, FILE1)])]);
    expect(none[0].citations).toEqual([]);
  });

  it('checks documents in batches of 100 and fails closed when the check fails', async () => {
    const many = Array.from({ length: 250 }, (_, i) => id(1000 + i));
    const msgs: StoredMessage[] = Array.from({ length: 13 }, (_, k) => ({
      id: id(70 + k), role: 'assistant', content: '', createdAt: 'x', status: 'complete', mentions: [], capabilityKey: null, knowledgeUnavailable: false,
      citations: many.slice(k * 20, k * 20 + 20).map((d, j) => cite(j + 1, d, FILE1)),
    }));
    const { db, calls } = fakeDb({ knowledge_documents: [] });
    await authorizeCitations(db, ORG, msgs);
    expect(calls.map((c) => (c.in.id ?? []).length)).toEqual([100, 100, 50]);
    await expect(authorizeCitations(fakeDb({}, new Set(['knowledge_documents'])).db, ORG, msgs)).rejects.toEqual(new ChatStoreError('STORE_UNAVAILABLE'));
  });

  it('stores only contract keys, bounded, and only on assistant messages', async () => {
    const long = { ...cite(1, DOC1, FILE1), snippet: 'x'.repeat(MAX_CITATION_SNIPPET + 50), extra: 'drop me' } as MessageCitation;
    const a = fakeDb({});
    const saved = await appendMessage(a.db, { organizationId: ORG, threadId: THREAD, role: 'assistant', content: 'A', citations: [long], knowledgeUnavailable: true });
    const v = a.calls[0].values!;
    expect(v.knowledge_unavailable).toBe(true);
    expect(v.citations).toEqual([{ ...cite(1, DOC1, FILE1), snippet: 'x'.repeat(MAX_CITATION_SNIPPET) }]);
    expect(saved.citations).toEqual(v.citations);
    expect(saved.knowledgeUnavailable).toBe(true);

    const u = fakeDb({});
    await appendMessage(u.db, { organizationId: ORG, threadId: THREAD, role: 'user', content: 'Q', citations: [cite(1, DOC1, FILE1)], knowledgeUnavailable: true });
    expect(u.calls[0].values).toMatchObject({ citations: [], knowledge_unavailable: false });
    const plain = fakeDb({});
    await appendMessage(plain.db, { organizationId: ORG, threadId: THREAD, role: 'assistant', content: 'A' });
    expect(plain.calls[0].values).toMatchObject({ citations: [], knowledge_unavailable: false });
  });
});
