'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Thread } from '@/components/chat/types';
import type { MessageKey } from '@/i18n/types';
import type { Conversation, Folder } from '@/lib/workspace-data/contracts';
import { hasArray, messageKeyFor, workspaceApi } from '@/lib/workspace/service';

/** Whether a Workspace backend capability works on this server: probed once, never assumed. */
export type Capability = 'unknown' | 'available' | 'unavailable';
/** Enough of a chat to put it back in the list after an undo or a restore. */
export type RestorableThread = Pick<Conversation, 'id' | 'title' | 'modelKey' | 'updatedAt' | 'folderId'>;
export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly message: MessageKey };
export type SearchOutcome =
  | { readonly mode: 'server'; readonly results: readonly Conversation[] }
  | { readonly mode: 'local' }
  | { readonly mode: 'error'; readonly message: MessageKey };

/**
 * The person's chats, shared by the Workspace sidebar (recent chats) and the chat view (which adds
 * a chat when the first message starts one). `busy` is true while an answer is streaming, so the
 * sidebar can hold navigation until it finishes or is stopped.
 *
 * Conversation management (folders, rename, archive, delete, full-history search) uses Agent 4's
 * conversations API. It is probed with GET /api/v1/chat/folders: until that answers with the
 * contract's shape, `manage` stays 'unavailable' and the sidebar offers none of it.
 */
export interface ThreadsState {
  readonly threads: Thread[] | null;
  readonly failed: boolean;
  readonly busy: boolean;
  readonly manage: Capability;
  readonly folders: readonly Folder[];
  retry(): void;
  add(thread: Thread): void;
  /** Marks a chat as just used: first message becomes the title of an untitled chat; moves it to the top. */
  touch(id: string, firstMessage: string): void;
  setBusy(busy: boolean): void;
  rename(id: string, title: string): Promise<ActionResult>;
  move(id: string, folderId: string | null): Promise<ActionResult>;
  archive(id: string): Promise<ActionResult>;
  restore(conversation: RestorableThread): Promise<ActionResult>;
  remove(id: string): Promise<ActionResult>;
  createFolder(name: string): Promise<ActionResult>;
  renameFolder(id: string, name: string): Promise<ActionResult>;
  deleteFolder(id: string): Promise<ActionResult>;
  search(query: string): Promise<SearchOutcome>;
  listArchived(): Promise<{ ok: true; threads: readonly Conversation[] } | { ok: false; message: MessageKey }>;
}

const ThreadsContext = createContext<ThreadsState | null>(null);

const toThread = (c: RestorableThread): Thread => ({ id: c.id, title: c.title, modelKey: c.modelKey, updatedAt: c.updatedAt, folderId: c.folderId });
const isContractList = (v: unknown): v is { threads: Conversation[]; nextCursor: string | null } => hasArray(v, 'threads') && 'nextCursor' in (v as object);
const byName = (a: Folder, b: Folder) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

export function ThreadsProvider({ initialThreads = null, children }: { initialThreads?: Thread[] | null; children: React.ReactNode }) {
  const [threads, setThreads] = useState<Thread[] | null>(initialThreads);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [manage, setManage] = useState<Capability>('unknown');
  const [folders, setFolders] = useState<Folder[]>([]);

  // State is only set when the request settles, never synchronously in the effect.
  const load = useCallback(() => fetch('/api/v1/chat/threads', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() as Promise<{ threads: Thread[] }>; })
    .then((d) => { setThreads(d.threads); setFailed(false); })
    .catch(() => { setThreads([]); setFailed(true); }), []);

  const needThreads = initialThreads === null;
  useEffect(() => { if (needThreads) void load(); }, [needThreads, load]);

  // Probe conversation management once. When it works, reload the list with folder ids.
  useEffect(() => {
    let live = true;
    const api = workspaceApi();
    void api.listFolders().then(async (r) => {
      if (!live) return;
      if (!r.ok || !hasArray(r.value, 'folders')) { setManage('unavailable'); return; }
      setFolders([...r.value.folders].sort(byName));
      const list = await api.listConversations({ archived: false, limit: 100 });
      if (!live) return;
      if (list.ok && isContractList(list.value)) {
        const fresh = list.value.threads.map(toThread);
        setThreads((old) => {
          // Keep chats started in this tab that the list does not have yet.
          const extra = (old ?? []).filter((t) => !fresh.some((f) => f.id === t.id) && Date.parse(t.updatedAt) > Date.now() - 60_000);
          return [...extra, ...fresh];
        });
        setFailed(false);
        setManage('available');
      } else setManage('unavailable');
    });
    return () => { live = false; };
  }, []);

  const retry = useCallback(() => { setFailed(false); setThreads(null); void load(); }, [load]);
  const add = useCallback((t: Thread) => setThreads((list) => [{ folderId: null, ...t }, ...(list ?? []).filter((x) => x.id !== t.id)]), []);
  const touch = useCallback((id: string, firstMessage: string) => setThreads((list) => {
    const all = list ?? [];
    const hit = all.find((x) => x.id === id);
    if (!hit) return all;
    const title = hit.title === 'New chat' ? firstMessage.slice(0, 60) : hit.title;
    return [{ ...hit, title, updatedAt: new Date().toISOString() }, ...all.filter((x) => x.id !== id)];
  }), []);

  const patchLocal = useCallback((id: string, patch: Partial<Thread>) => setThreads((list) => (list ?? []).map((t) => (t.id === id ? { ...t, ...patch } : t))), []);
  const dropLocal = useCallback((id: string) => setThreads((list) => (list ?? []).filter((t) => t.id !== id)), []);

  const rename = useCallback(async (id: string, title: string): Promise<ActionResult> => {
    const r = await workspaceApi().updateConversation(id, { title });
    if (!r.ok) return { ok: false, message: messageKeyFor(r) };
    patchLocal(id, { title: r.value.thread?.title ?? title });
    return { ok: true };
  }, [patchLocal]);

  const move = useCallback(async (id: string, folderId: string | null): Promise<ActionResult> => {
    const r = await workspaceApi().updateConversation(id, { folderId });
    if (!r.ok) return { ok: false, message: messageKeyFor(r) };
    patchLocal(id, { folderId });
    return { ok: true };
  }, [patchLocal]);

  const archive = useCallback(async (id: string): Promise<ActionResult> => {
    const r = await workspaceApi().updateConversation(id, { archived: true });
    if (!r.ok) return { ok: false, message: messageKeyFor(r) };
    dropLocal(id);
    return { ok: true };
  }, [dropLocal]);

  const restore = useCallback(async (c: RestorableThread): Promise<ActionResult> => {
    const r = await workspaceApi().updateConversation(c.id, { archived: false });
    if (!r.ok) return { ok: false, message: messageKeyFor(r) };
    const t = toThread(r.value.thread ?? c);
    setThreads((list) => [t, ...(list ?? []).filter((x) => x.id !== t.id)].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
    return { ok: true };
  }, []);

  const remove = useCallback(async (id: string): Promise<ActionResult> => {
    const r = await workspaceApi().deleteConversation(id);
    if (!r.ok) return { ok: false, message: messageKeyFor(r) };
    dropLocal(id);
    return { ok: true };
  }, [dropLocal]);

  const createFolder = useCallback(async (name: string): Promise<ActionResult> => {
    const r = await workspaceApi().createFolder(name);
    if (!r.ok) return { ok: false, message: messageKeyFor(r) };
    setFolders((f) => [...f, r.value.folder].sort(byName));
    return { ok: true };
  }, []);

  const renameFolder = useCallback(async (id: string, name: string): Promise<ActionResult> => {
    const r = await workspaceApi().renameFolder(id, name);
    if (!r.ok) return { ok: false, message: messageKeyFor(r) };
    setFolders((f) => f.map((x) => (x.id === id ? r.value.folder : x)).sort(byName));
    return { ok: true };
  }, []);

  /** The server unfiles the folder's chats; mirror that locally. */
  const deleteFolder = useCallback(async (id: string): Promise<ActionResult> => {
    const r = await workspaceApi().deleteFolder(id);
    if (!r.ok) return { ok: false, message: messageKeyFor(r) };
    setFolders((f) => f.filter((x) => x.id !== id));
    setThreads((list) => (list ?? []).map((t) => (t.folderId === id ? { ...t, folderId: null } : t)));
    return { ok: true };
  }, []);

  const search = useCallback(async (query: string): Promise<SearchOutcome> => {
    if (manage !== 'available') return { mode: 'local' };
    const r = await workspaceApi().listConversations({ q: query, limit: 30 });
    if (!r.ok) return { mode: 'error', message: messageKeyFor(r) };
    return isContractList(r.value) ? { mode: 'server', results: r.value.threads } : { mode: 'local' };
  }, [manage]);

  const listArchived = useCallback(async () => {
    const r = await workspaceApi().listConversations({ archived: true, limit: 100 });
    if (!r.ok) return { ok: false as const, message: messageKeyFor(r) };
    return isContractList(r.value) ? { ok: true as const, threads: r.value.threads } : { ok: false as const, message: 'workspace.err.unavailable' as MessageKey };
  }, []);

  const value = useMemo<ThreadsState>(() => ({
    threads, failed, busy, manage, folders, retry, add, touch, setBusy,
    rename, move, archive, restore, remove, createFolder, renameFolder, deleteFolder, search, listArchived,
  }), [threads, failed, busy, manage, folders, retry, add, touch, rename, move, archive, restore, remove, createFolder, renameFolder, deleteFolder, search, listArchived]);
  return <ThreadsContext.Provider value={value}>{children}</ThreadsContext.Provider>;
}

export function useThreads(): ThreadsState {
  const value = useContext(ThreadsContext);
  if (!value) throw new Error('useThreads() must be used inside <ThreadsProvider>');
  return value;
}
