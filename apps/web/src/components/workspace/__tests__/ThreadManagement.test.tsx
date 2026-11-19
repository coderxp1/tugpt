// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { Conversation, Folder } from '@/lib/workspace-data/contracts';

vi.mock('next/navigation', () => ({ usePathname: () => '/workspace', useSearchParams: () => new URLSearchParams() }));
import { ThreadList } from '@/components/chat/ThreadList';
import { ThreadsProvider, useThreads } from '../ThreadsProvider';
import { fakeApi, iso } from './fake-api';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const conv = (id: string, title: string, folderId: string | null = null, extra: Partial<Conversation> = {}): Conversation => ({
  id, title, modelKey: 'scout', folderId, archivedAt: null, createdAt: iso(60), updatedAt: iso(5), matchSource: null, snippet: null, ...extra,
});
const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
const F: Folder = { id: 'f0000000-0000-4000-8000-00000000000f', name: 'Carriers', createdAt: iso(90), updatedAt: iso(90) };

function List({ query = '' }: { query?: string }) {
  const { threads, failed, retry, busy } = useThreads();
  return <ThreadList threads={threads} failed={failed} activeId={null} busy={busy} query={query} onRetry={retry} />;
}
function setup(extra: Parameters<typeof fakeApi>[0] = {}) {
  let list = [conv(A, 'Q4 pricing notes', F.id), conv(B, 'Weekly ops review')];
  const api = fakeApi({
    'GET /api/v1/chat/folders': () => ({ body: { folders: [F] } }),
    'GET /api/v1/chat/threads': ({ url }) => {
      const q = url.searchParams.get('q');
      if (url.searchParams.get('archived') === 'true') return { body: { threads: [conv('c0000000-0000-4000-8000-00000000000c', 'Old supplier chat', null, { archivedAt: iso(9) })], nextCursor: null } };
      if (q) return { body: { threads: [conv(B, 'Weekly ops review', null, { matchSource: 'message', snippet: '…the carrier invoice was late…' })], nextCursor: null } };
      return { body: { threads: list, nextCursor: null } };
    },
    'PATCH /api/v1/chat/threads/:id': ({ url, body }) => {
      const id = url.pathname.split('/').pop()!;
      const hit = list.find((x) => x.id === id) ?? conv(id, 'Old supplier chat');
      const next = { ...hit, ...(body as object) } as Conversation;
      list = list.map((x) => (x.id === id ? next : x));
      return { body: { thread: next } };
    },
    'DELETE /api/v1/chat/threads/:id': () => ({ body: { deleted: true } }),
    'POST /api/v1/chat/folders': ({ body }) => ({ status: 201, body: { folder: { ...F, id: 'f2', name: (body as { name: string }).name } } }),
    ...extra,
  });
  return api;
}

describe('Recent chats with conversation management', () => {
  it('shows folders with their chats and the remaining chats by date', async () => {
    setup();
    render(<ThreadsProvider initialThreads={[]}><List /></ThreadsProvider>);
    const folder = await screen.findByText('Carriers');
    const details = folder.closest('details')!;
    fireEvent.click(within(details).getByText('Carriers'));
    expect(within(details).getByRole('link', { name: /Q4 pricing notes/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Weekly ops review/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New folder' })).toBeTruthy();
  });

  it('renames a chat from its menu', async () => {
    const api = setup();
    render(<ThreadsProvider initialThreads={[]}><List /></ThreadsProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Options for Weekly ops review' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename chat' });
    fireEvent.change(within(dialog).getByLabelText('Chat title'), { target: { value: 'Ops review – week 46' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('link', { name: /Ops review – week 46/ })).toBeTruthy();
    const patch = api.calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({ title: 'Ops review – week 46' });
    expect(patch?.headers['x-tugpt-csrf']).toBe('1');
  });

  it('deletes only after confirmation in an alert dialog', async () => {
    const api = setup();
    render(<ThreadsProvider initialThreads={[]}><List /></ThreadsProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Options for Weekly ops review' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Delete this chat?' });
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete chat' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: /Weekly ops review/ })).toBeNull());
    expect(screen.getByText('Chat deleted.')).toBeTruthy();
  });

  it('archives with undo', async () => {
    const api = setup();
    render(<ThreadsProvider initialThreads={[]}><List /></ThreadsProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Options for Weekly ops review' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: /Weekly ops review/ })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('link', { name: /Weekly ops review/ })).toBeTruthy();
    expect(api.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ archived: true }, { archived: false }]);
  });

  it('searches every chat on the server and shows where the match was found', async () => {
    const api = setup();
    render(<ThreadsProvider initialThreads={[]}><List query="invoice" /></ThreadsProvider>);
    expect(await screen.findByText('…the carrier invoice was late…')).toBeTruthy();
    expect(screen.getByText('Searching all your chats, including message text.')).toBeTruthy();
    expect(api.calls.some((c) => c.path === '/api/v1/chat/threads' && c.search.includes('q=invoice'))).toBe(true);
  });

  it('lists archived chats and restores one', async () => {
    setup();
    render(<ThreadsProvider initialThreads={[]}><List /></ThreadsProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Archived chats' }));
    const dialog = screen.getByRole('dialog', { name: 'Archived chats' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Restore Old supplier chat' }));
    expect(await screen.findByRole('link', { name: /Old supplier chat/ })).toBeTruthy();
  });

  it('without the conversations API: no folders, no menus, local search only', async () => {
    const api = fakeApi({});
    render(<ThreadsProvider initialThreads={[conv(A, 'Q4 pricing notes')]}><List query="q4" /></ThreadsProvider>);
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/v1/chat/folders')).toBe(true));
    expect(screen.getByRole('link', { name: /Q4 pricing notes/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Options for/ })).toBeNull();
    expect(screen.getByText('Searching your most recent chats.')).toBeTruthy();
    expect(api.calls.some((c) => c.search.includes('q='))).toBe(false);
  });
});


it('drains opaque pages through recent, search and archive provider paths', async () => {
  const cursor = 'c1.exact+/=%opaque';
  const api = setup({ 'GET /api/v1/chat/threads': ({ url }) => {
    const next = url.searchParams.has('before');
    return { body: { threads: [conv(next ? B : A, next ? 'Second' : 'First', null, { updatedAt: '2026-01-01T00:00:00Z' })], nextCursor: next ? null : cursor } };
  } });
  const { result } = renderHook(() => useThreads(), { wrapper: ({ children }) => <ThreadsProvider initialThreads={[]}>{children}</ThreadsProvider> });
  await waitFor(() => expect(result.current.manage).toBe('available'));
  expect(result.current.threads?.map((t) => t.id)).toEqual([A, B]);
  const search = await result.current.search('keyword');
  expect(search.mode === 'server' && search.results.map((t) => t.id)).toEqual([A, B]);
  const archived = await result.current.listArchived();
  expect(archived.ok && archived.threads.map((t) => t.id)).toEqual([A, B]);
  const continued = api.calls.map((c) => new URLSearchParams(c.search)).filter((q) => q.has('before'));
  expect(continued).toHaveLength(3);
  expect(continued.every((q) => q.get('before') === cursor)).toBe(true);
  expect(continued.some((q) => q.get('q') === 'keyword')).toBe(true);
  expect(continued.some((q) => q.get('archived') === 'true')).toBe(true);
});
