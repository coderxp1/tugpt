'use client';

import Link from 'next/link';
import { useEffect, useId, useMemo, useState } from 'react';
import { useT } from '@/i18n/provider';
import type { MessageKey } from '@/i18n/types';
import type { Conversation, Folder } from '@/lib/workspace-data/contracts';
import { WORKSPACE_HOME, threadHref } from '@/lib/workspace/routes';
import { filterThreads, groupThreads, type ThreadGroupKey } from '@/lib/workspace/group-threads';
import { ActionMenu, type MenuAction } from '@/components/workspace/ActionMenu';
import { Dialog } from '@/components/workspace/Dialog';
import { Icon } from '@/components/workspace/icons';
import { useThreads, type ActionResult, type SearchOutcome } from '@/components/workspace/ThreadsProvider';
import u from '@/components/workspace/ui.module.css';
import type { Thread } from './types';
import s from './threads.module.css';

export interface ThreadListProps {
  readonly threads: Thread[] | null;
  readonly failed: boolean;
  readonly activeId: string | null;
  /** An answer is streaming: other chats cannot be opened until it finishes or is stopped. */
  readonly busy: boolean;
  /** The sidebar search. Empty: folders and grouped recent chats. */
  readonly query?: string;
  onRetry(): void;
  /** Called when a chat is opened (the mobile drawer closes). */
  onOpen?(): void;
}

const GROUP_LABEL: Record<ThreadGroupKey, MessageKey> = {
  today: 'workspace.group.today', yesterday: 'workspace.group.yesterday', week: 'workspace.group.week', older: 'workspace.group.older',
};
const SEARCH_DELAY_MS = 250;
const NAME_MAX = 120;

type Pending =
  | { kind: 'rename'; thread: Thread }
  | { kind: 'move'; thread: Thread }
  | { kind: 'delete'; thread: Thread }
  | { kind: 'newFolder' }
  | { kind: 'renameFolder'; folder: Folder }
  | { kind: 'deleteFolder'; folder: Folder }
  | { kind: 'archived' };
type Server = { query: string; outcome: SearchOutcome } | null;
type Notice = { text: string; undo?: () => void } | null;

/**
 * The person's chats. Each is a real link (/workspace/c/<id>), so it can be opened in a new tab.
 * When the conversations API is available (`manage`), chats can be renamed, filed in folders,
 * archived (with undo) and deleted (after confirmation), and the search covers every chat on the
 * server, including message text. Without it this is exactly the earlier recent-chats list.
 */
export function ThreadList({ threads, failed, activeId, busy, query = '', onRetry, onOpen }: ThreadListProps) {
  const t = useT();
  const ctx = useThreads();
  const { manage, folders, search: searchServer } = ctx;
  const headingId = useId();
  const busyId = useId();
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [server, setServer] = useState<Server>(null);
  const q = query.trim();
  const searching = q.length > 0;
  const canManage = manage === 'available';

  // Server search, debounced; the local filter below answers immediately meanwhile.
  useEffect(() => {
    if (!canManage || q.length < 2) return;
    let live = true;
    const timer = setTimeout(() => { void searchServer(q).then((outcome) => { if (live) setServer({ query: q, outcome }); }); }, SEARCH_DELAY_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [q, canManage, searchServer]);

  const serverHit = server && server.query === q && server.outcome.mode === 'server' ? server.outcome.results : null;
  const serverError = server && server.query === q && server.outcome.mode === 'error' ? server.outcome.message : null;

  const local = useMemo(() => (threads && searching ? filterThreads(threads, query) : []), [threads, query, searching]);
  const results: (Thread & Partial<Pick<Conversation, 'matchSource' | 'snippet'>>)[] = serverHit ? serverHit.map((c) => ({ ...c })) : local;
  const filed = useMemo(() => {
    const m = new Map<string, Thread[]>();
    if (canManage) for (const th of threads ?? []) if (th.folderId) m.set(th.folderId, [...(m.get(th.folderId) ?? []), th]);
    return m;
  }, [threads, canManage]);
  const unfiled = useMemo(() => (threads ?? []).filter((th) => !canManage || !th.folderId || !folders.some((f) => f.id === th.folderId)), [threads, canManage, folders]);
  const groups = useMemo(() => groupThreads(unfiled), [unfiled]);

  // Notices disappear by themselves; an undo stays offered for 8 seconds.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.undo ? 8000 : 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  function leaveIfOpen(id: string) {
    if (id === activeId) window.history.pushState(null, '', WORKSPACE_HOME);
  }
  async function run(action: Promise<ActionResult>, done: string, undo?: () => void): Promise<boolean> {
    const r = await action;
    setNotice(r.ok ? { text: done, undo } : { text: t(r.message) });
    return r.ok;
  }

  const threadActions = (th: Thread): MenuAction[] => [
    { key: 'rename', label: t('workspace.thread.rename'), icon: 'pencil', onSelect: () => setPending({ kind: 'rename', thread: th }) },
    { key: 'move', label: t('workspace.thread.move'), icon: 'folder', onSelect: () => setPending({ kind: 'move', thread: th }) },
    {
      key: 'archive', label: t('workspace.thread.archive'), icon: 'archive', onSelect: () => {
        void run(ctx.archive(th.id), t('workspace.thread.archived', { title: th.title }), () => { void run(ctx.restore({ folderId: null, ...th }), t('workspace.thread.restored', { title: th.title })); })
          .then((ok) => { if (ok) leaveIfOpen(th.id); });
      },
    },
    { key: 'delete', label: t('workspace.thread.delete'), icon: 'trash', danger: true, separated: true, onSelect: () => setPending({ kind: 'delete', thread: th }) },
  ];

  const item = (th: Thread & { matchSource?: Conversation['matchSource']; snippet?: string | null }) => {
    const active = th.id === activeId;
    const held = busy && !active;
    return (
      <li key={th.id} className={canManage ? s.row : undefined}>
        <Link href={threadHref(th.id)} prefetch={false} title={th.title}
          className={active ? s.itemActive : s.item}
          aria-current={active ? 'page' : undefined}
          aria-disabled={held ? 'true' : undefined}
          aria-describedby={held ? busyId : undefined}
          onClick={(e) => { if (held) { e.preventDefault(); return; } onOpen?.(); }}>
          <span className={s.title}>{th.title}</span>
          {th.matchSource === 'message' && th.snippet && <span className={s.snippet}><span className={s.sr}>{t('workspace.search.inMessages')}: </span>{th.snippet}</span>}
        </Link>
        {canManage && <ActionMenu className={s.more} label={t('workspace.thread.options', { title: th.title })} actions={threadActions(th)} />}
      </li>
    );
  };

  const searchBody = () => {
    if (results.length === 0) return <p className={s.muted}>{t('workspace.noMatches', { query: q })}</p>;
    return <ul className={s.list}>{results.map(item)}</ul>;
  };

  const listBody = () => (
    <>
      {canManage && (
        <div className={s.folders}>
          <div className={s.sectionHead}>
            <h3 className={s.groupLabel}>{t('workspace.folders')}</h3>
            <button type="button" className={s.headButton} onClick={() => setPending({ kind: 'newFolder' })} aria-label={t('workspace.folder.new')} title={t('workspace.folder.new')}><Icon name="folderPlus" size={16} /></button>
          </div>
          {folders.length === 0
            ? <p className={s.muted}>{t('workspace.folder.none')}</p>
            : folders.map((f) => {
                const inside = filed.get(f.id) ?? [];
                return (
                  <div key={f.id} className={s.folder}>
                  <details open={inside.some((x) => x.id === activeId) || undefined}>
                    <summary className={s.folderSummary}>
                      <Icon name="folder" size={16} /><span className={s.title}>{f.name}</span><span className={s.count}>{inside.length}</span>
                    </summary>
                    {inside.length === 0 ? <p className={s.mutedIndent}>{t('workspace.folder.empty')}</p> : <ul className={`${s.list} ${s.indent}`}>{inside.map(item)}</ul>}
                  </details>
                    <ActionMenu className={s.folderMore} label={t('workspace.folder.options', { name: f.name })} actions={[
                      { key: 'rename', label: t('workspace.folder.rename'), icon: 'pencil', onSelect: () => setPending({ kind: 'renameFolder', folder: f }) },
                      { key: 'delete', label: t('workspace.folder.delete'), icon: 'trash', danger: true, onSelect: () => setPending({ kind: 'deleteFolder', folder: f }) },
                    ]} />
                  </div>
                );
              })}
        </div>
      )}
      {(threads ?? []).length === 0
        ? <p className={s.muted}>{t('workspace.noChats')}</p>
        : groups.map((g) => (
            <div key={g.key} className={s.group}>
              <h3 className={s.groupLabel}>{t(GROUP_LABEL[g.key])}</h3>
              <ul className={s.list}>{g.threads.map(item)}</ul>
            </div>
          ))}
    </>
  );

  return (
    <section className={s.recent} aria-labelledby={headingId}>
      <h2 id={headingId} className={s.label}>{searching ? t('workspace.searchResults') : t('workspace.recent')}</h2>
      {searching && threads && <p className={s.sr} role="status">{t('workspace.searchCount', { count: results.length })}</p>}
      <div className={s.scroll}>
        {threads === null
          ? <ul className={s.list} aria-busy="true" aria-label={t('workspace.loadingChats')}>{[0, 1, 2].map((i) => <li key={i} className={s.skeleton} />)}<li className={s.sr} role="status">{t('workspace.loadingChats')}…</li></ul>
          : failed
            ? <div className={s.loadError} role="alert"><p>{t('workspace.chatsFailed')}</p><button type="button" onClick={onRetry}>{t('workspace.tryAgain')}</button></div>
            : searching ? searchBody() : listBody()}
      </div>
      <div className={s.live} role="status" aria-live="polite">
        {notice && <p className={s.toast}>{notice.text}{notice.undo && <button type="button" onClick={() => { const undo = notice.undo; setNotice(null); undo?.(); }}>{t('workspace.undo')}</button>}</p>}
      </div>
      {busy && <p id={busyId} className={s.note}>{t('workspace.busyHint')}</p>}
      {serverError && searching && <p className={s.noteWarn}>{t('workspace.search.serverFailed')} {t(serverError)}</p>}
      <p className={s.note}>{searching ? (serverHit ? t('workspace.search.allChats') : t('workspace.searchScope')) : t('workspace.private')}</p>
      {canManage && !searching && <button type="button" className={s.archivedLink} onClick={() => setPending({ kind: 'archived' })}><Icon name="archive" size={15} />{t('workspace.archived.open')}</button>}

      {pending?.kind === 'rename' && (
        <NameDialog title={t('workspace.thread.renameTitle')} label={t('workspace.thread.titleLabel')} initial={pending.thread.title} submit={t('workspace.save')}
          onClose={() => setPending(null)} onSubmit={(name) => ctx.rename(pending.thread.id, name)} onDone={() => setNotice({ text: t('workspace.thread.renamed') })} />
      )}
      {pending?.kind === 'newFolder' && (
        <NameDialog title={t('workspace.folder.new')} label={t('workspace.folder.nameLabel')} initial="" submit={t('workspace.create')}
          onClose={() => setPending(null)} onSubmit={(name) => ctx.createFolder(name)} onDone={() => setNotice({ text: t('workspace.folder.created') })} />
      )}
      {pending?.kind === 'renameFolder' && (
        <NameDialog title={t('workspace.folder.rename')} label={t('workspace.folder.nameLabel')} initial={pending.folder.name} submit={t('workspace.save')}
          onClose={() => setPending(null)} onSubmit={(name) => ctx.renameFolder(pending.folder.id, name)} onDone={() => setNotice({ text: t('workspace.folder.renamed') })} />
      )}
      {pending?.kind === 'move' && <MoveDialog thread={pending.thread} folders={folders} onClose={() => setPending(null)}
        onMove={(folderId) => ctx.move(pending.thread.id, folderId)} onDone={(name) => setNotice({ text: name ? t('workspace.thread.movedTo', { folder: name }) : t('workspace.thread.unfiled') })}
        onNewFolder={() => setPending({ kind: 'newFolder' })} />}
      {pending?.kind === 'delete' && (
        <ConfirmDialog title={t('workspace.thread.deleteTitle')} body={t('workspace.thread.deleteBody', { title: pending.thread.title })} confirm={t('workspace.thread.deleteConfirm')}
          onClose={() => setPending(null)} onConfirm={() => ctx.remove(pending.thread.id)}
          onDone={() => { leaveIfOpen(pending.thread.id); setNotice({ text: t('workspace.thread.deleted') }); }} />
      )}
      {pending?.kind === 'deleteFolder' && (
        <ConfirmDialog title={t('workspace.folder.deleteTitle')} body={t('workspace.folder.deleteBody', { name: pending.folder.name })} confirm={t('workspace.folder.deleteConfirm')}
          onClose={() => setPending(null)} onConfirm={() => ctx.deleteFolder(pending.folder.id)} onDone={() => setNotice({ text: t('workspace.folder.deleted') })} />
      )}
      {pending?.kind === 'archived' && <ArchivedDialog onClose={() => setPending(null)} onRestored={(title) => setNotice({ text: t('workspace.thread.restored', { title }) })} />}
    </section>
  );
}

function NameDialog({ title, label, initial, submit, onClose, onSubmit, onDone }: {
  title: string; label: string; initial: string; submit: string; onClose(): void; onSubmit(name: string): Promise<ActionResult>; onDone(): void;
}) {
  const t = useT();
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const id = useId();
  const name = value.trim();
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name || saving) return;
    setSaving(true);
    const r = await onSubmit(name);
    setSaving(false);
    if (r.ok) { onClose(); onDone(); } else setError(r.message);
  }
  return (
    <Dialog title={title} onClose={onClose}>
      <form onSubmit={save} className={u.dialogBody}>
        <label className={u.field} htmlFor={id}>
          <span>{label}</span>
          <input id={id} value={value} maxLength={NAME_MAX} onChange={(e) => { setValue(e.target.value); setError(null); }} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : undefined} />
        </label>
        {error && <p id={`${id}-err`} className={u.fieldError} role="alert">{t(error)}</p>}
        <div className={u.dialogFoot}>
          <button type="button" className={u.button} onClick={onClose}>{t('workspace.cancel')}</button>
          <button type="submit" className={u.buttonPrimary} disabled={!name || name === initial.trim() || saving}>{saving ? t('workspace.saving') : submit}</button>
        </div>
      </form>
    </Dialog>
  );
}

function ConfirmDialog({ title, body, confirm, onClose, onConfirm, onDone }: {
  title: string; body: string; confirm: string; onClose(): void; onConfirm(): Promise<ActionResult>; onDone(): void;
}) {
  const t = useT();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  async function go() {
    setWorking(true);
    const r = await onConfirm();
    setWorking(false);
    if (r.ok) { onClose(); onDone(); } else setError(r.message);
  }
  return (
    <Dialog title={title} description={body} tone="alert" onClose={onClose} footer={<>
      <button type="button" className={u.button} onClick={onClose} data-autofocus>{t('workspace.cancel')}</button>
      <button type="button" className={u.buttonDanger} onClick={() => void go()} disabled={working}>{working ? t('workspace.working') : confirm}</button>
    </>}>
      {error && <p className={u.fieldError} role="alert">{t(error)}</p>}
    </Dialog>
  );
}

function MoveDialog({ thread, folders, onClose, onMove, onDone, onNewFolder }: {
  thread: Thread; folders: readonly Folder[]; onClose(): void; onMove(folderId: string | null): Promise<ActionResult>; onDone(name: string | null): void; onNewFolder(): void;
}) {
  const t = useT();
  const [choice, setChoice] = useState<string>(thread.folderId ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const r = await onMove(choice || null);
    setSaving(false);
    if (r.ok) { onClose(); onDone(folders.find((f) => f.id === choice)?.name ?? null); } else setError(r.message);
  }
  return (
    <Dialog title={t('workspace.thread.moveTitle', { title: thread.title })} onClose={onClose}>
      <form onSubmit={save} className={u.dialogBody}>
        <fieldset className={u.choices}>
          <legend className={u.sr}>{t('workspace.thread.move')}</legend>
          <label className={u.choice}><input type="radio" name="folder" value="" checked={choice === ''} onChange={() => setChoice('')} /><span>{t('workspace.folder.noFolder')}</span></label>
          {folders.map((f) => (
            <label key={f.id} className={u.choice}><input type="radio" name="folder" value={f.id} checked={choice === f.id} onChange={() => setChoice(f.id)} /><span>{f.name}</span></label>
          ))}
        </fieldset>
        {folders.length === 0 && <p className={u.help}>{t('workspace.folder.none')}</p>}
        {error && <p className={u.fieldError} role="alert">{t(error)}</p>}
        <div className={u.dialogFoot}>
          <button type="button" className={u.buttonGhost} onClick={onNewFolder}><Icon name="folderPlus" size={15} />{t('workspace.folder.new')}</button>
          <button type="button" className={u.button} onClick={onClose}>{t('workspace.cancel')}</button>
          <button type="submit" className={u.buttonPrimary} disabled={saving || choice === (thread.folderId ?? '')}>{saving ? t('workspace.saving') : t('workspace.thread.moveConfirm')}</button>
        </div>
      </form>
    </Dialog>
  );
}

function ArchivedDialog({ onClose, onRestored }: { onClose(): void; onRestored(title: string): void }) {
  const t = useT();
  const { listArchived, restore } = useThreads();
  const [list, setList] = useState<readonly Conversation[] | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [working, setWorking] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let live = true;
    void listArchived().then((r) => { if (!live) return; if (r.ok) { setList(r.threads); setError(null); } else setError(r.message); });
    return () => { live = false; };
  }, [listArchived, attempt]);
  async function back(c: Conversation) {
    setWorking((w) => new Set(w).add(c.id));
    const r = await restore(c);
    setWorking((w) => { const n = new Set(w); n.delete(c.id); return n; });
    if (r.ok) { setList((l) => (l ?? []).filter((x) => x.id !== c.id)); onRestored(c.title); } else setError(r.message);
  }
  return (
    <Dialog title={t('workspace.archived.title')} description={t('workspace.archived.body')} onClose={onClose} wide>
      {error && <div className={u.error} role="alert"><p>{t(error)}</p><button type="button" className={u.button} onClick={() => { setError(null); setList(null); setAttempt((n) => n + 1); }}>{t('workspace.tryAgain')}</button></div>}
      {!error && list === null && <div className={u.loading} aria-busy="true"><div className={u.skeleton} /><div className={u.skeleton} /><span className={u.sr} role="status">{t('workspace.loadingChats')}…</span></div>}
      {list && list.length === 0 && <p className={u.help}>{t('workspace.archived.none')}</p>}
      {list && list.length > 0 && (
        <ul className={s.archivedList}>
          {list.map((c) => (
            <li key={c.id}>
              <span className={s.title}>{c.title}</span>
              <button type="button" className={u.button} disabled={working.has(c.id)} onClick={() => void back(c)} aria-label={t('workspace.archived.restoreNamed', { title: c.title })}>
                {t('workspace.archived.restore')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
