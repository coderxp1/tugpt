import { describe, expect, it, vi } from 'vitest';
import { agentPermissions } from './agent-permissions';
import { conversationPages } from './conversation-pages';
import { createWorkspaceClient, type Conversation } from '@/lib/workspace-data/contracts';
import { parseAgentIdentity, parseAgentCitations } from './agent-events';

const own = { ownedByMe: true, canEdit: true, canDelete: true };
describe('Q678 permissions', () => {
  it.each(['owner', 'admin', 'manager', 'agent'])('allows %s only with resource permission', (role) => {
    expect(agentPermissions(role, own).edit).toBe(true);
    expect(agentPermissions(role, { ...own, canEdit: false }).edit).toBe(false);
    expect(agentPermissions(role, { ...own, ownedByMe: false }).edit).toBe(false);
    expect(agentPermissions(role, { ...own, canDelete: false }).delete).toBe(false);
  });
  it.each(['viewer', 'member', 'reader', undefined, 'unknown', '', 'OWNER', 'constructor'])('fails closed for %s', (role) => {
    expect(agentPermissions(role, own)).toEqual({ create: false, share: false, edit: false, delete: false });
  });
  it('allows admin deletion of nonowned organization resource when server grants it', () => {
    expect(agentPermissions('admin', { ...own, ownedByMe: false, canEdit: false })).toEqual({ create: true, share: true, edit: false, delete: true });
    expect(agentPermissions('agent').share).toBe(false);
  });
});
const row = (id: string): Conversation => ({ id, title: id, modelKey: 'scout', folderId: null, archivedAt: null, createdAt: '2026-01-01', updatedAt: '2026-01-01', matchSource: null, snippet: null });
describe('opaque conversation pagination', () => {
  it.each([{ archived: false }, { q: 'pricing' }, { archived: true }])('roundtrips opaque before with filters %j', async (query) => {
    const cursor = 'c1.opaque+/=%token';
    const urls: URL[] = [];
    const client = createWorkspaceClient(async (input) => {
      const url = new URL(input, 'https://test.invalid'); urls.push(url);
      return new Response(JSON.stringify(url.searchParams.has('before') ? { threads: [row('a'), row('b')], nextCursor: null } : { threads: [row('a')], nextCursor: cursor }));
    });
    const result = await conversationPages(client, { ...query, limit: 1 });
    expect(result.ok && result.value.threads.map((r) => r.id)).toEqual(['a', 'b']);
    expect(urls[1].searchParams.get('before')).toBe(cursor);
    for (const [key, value] of Object.entries(query)) expect(urls[1].searchParams.get(key)).toBe(String(value));
  });
  it('rejects repeated cursors rather than looping', async () => {
    const listConversations = vi.fn(async () => ({ ok: true as const, value: { threads: [], nextCursor: 'same' } }));
    expect(await conversationPages({ listConversations }, {})).toMatchObject({ ok: false, error: 'UNEXPECTED_RESPONSE' });
    expect(listConversations).toHaveBeenCalledTimes(2);
  });
  it('propagates a later page error instead of presenting a partial success', async () => {
    const listConversations = vi.fn().mockResolvedValueOnce({ ok: true, value: { threads: [], nextCursor: 'next' } }).mockResolvedValueOnce({ ok: false, status: 403, error: 'FORBIDDEN' });
    expect(await conversationPages({ listConversations }, {})).toEqual({ ok: false, status: 403, error: 'FORBIDDEN' });
  });
  it('rejects malformed cursor metadata', async () => {
    const listConversations = vi.fn().mockResolvedValue({ ok: true, value: { threads: [], nextCursor: 3 } });
    expect((await conversationPages({ listConversations }, {})).ok).toBe(false);
  });
});
describe('agent event runtime checks', () => {
  it('validates identity and version', () => {
    expect(parseAgentIdentity({ id: 'a', name: 'Research', version: 1 })).toEqual({ id: 'a', name: 'Research', version: 1 });
    expect(parseAgentIdentity({ id: 'a', name: 'Research' })).toBeNull();
  });
  it('drops malformed citations without interpreting their text as markup', () => {
    const citation = { n: 1, documentId: 'd', collectionId: 'c', fileId: 'f', title: '<script>text</script>', ordinal: 0, snippet: 'Source' };
    expect(parseAgentCitations([citation, null, { ...citation, n: -1 }])).toEqual([citation]);
    expect(parseAgentCitations('invalid')).toEqual([]);
  });
});
