'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '@/i18n/provider';
import type { MessageKey } from '@/i18n/types';
import type { Collection, CollectionDetail, DocumentStatus, FileVisibility, LibraryDocument, SearchHit } from '@/lib/workspace-data/contracts';
import { hasArray, messageKeyFor, workspaceApi } from '@/lib/workspace/service';
import { LIBRARY_ACCEPT, UPLOAD_MAX_BYTES, formatBytes, isUploadable, mediaTypeFor } from '@/lib/workspace/uploads';
import { uploadSafely } from '@/lib/workspace/file-upload';
import { ActionMenu } from './ActionMenu';
import { Dialog } from './Dialog';
import { Icon } from './icons';
import { Badge, EmptyState, LoadingRows, ServiceNotice, When, type Tone } from './states';
import { useLoad } from './useLoad';
import s from './pages.module.css';
import c from './library.module.css';
import u from './ui.module.css';

const STATUS_TONE: Record<DocumentStatus, Tone> = { pending: 'warn', indexing: 'info', ready: 'good', failed: 'bad', unsupported: 'neutral' };
const NAME_MAX = 120;
const DESC_MAX = 500;
const POLL_MS = 5000;
const DOC_ERRORS: Record<string, MessageKey> = {
  PDF_NO_TEXT_LAYER: 'workspace.lib.err.noText',
  UNSUPPORTED_FOR_INDEXING: 'workspace.lib.err.type',
  PDF_EXTRACTION_UNAVAILABLE: 'workspace.lib.err.pdf',
  UNSUPPORTED_MEDIA_TYPE: 'workspace.lib.err.type',
  TOO_MANY_CHUNKS: 'workspace.lib.err.tooBig',
  FILE_MISSING: 'workspace.lib.err.missing',
  STORAGE_UNAVAILABLE: 'workspace.lib.err.storage',
};

type Editing = { mode: 'new' } | { mode: 'edit'; collection: Collection } | null;

/**
 * Knowledge collections (Agent 4's Library API): named sets of documents the organization can
 * search and, later, link to chats and agents. Lists, creates, edits and deletes collections,
 * uploads documents with progress, shows indexing status (PDF text extraction is reported as
 * not available yet, never as "ready"), and searches the indexed text.
 * When the API is not deployed here, it says so once and the rest of the Library still works.
 */
export function Collections({ uploadScope }: { uploadScope?: string }) {
  const t = useT();
  const { load, reload, update } = useLoad<{ collections: readonly Collection[] }>('collections', () => workspaceApi().listCollections(), (v) => hasArray(v, 'collections'));
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const collections = load.state === 'ready' ? load.value.collections : [];
  const current = collections.find((x) => x.id === open) ?? null;

  return (
    <section className={s.section} aria-labelledby="lib-collections">
      <div className={s.sectionHead}>
        <h2 id="lib-collections">{t('workspace.lib.collections')}</h2>
        {load.state === 'ready' && !current && <button type="button" className={u.buttonPrimary} onClick={() => setEditing({ mode: 'new' })}><Icon name="plus" size={15} />{t('workspace.lib.new')}</button>}
      </div>
      <div role="status" aria-live="polite" className={c.live}>{notice && <p className={c.toast}>{notice}</p>}</div>
      {load.state === 'loading' && <LoadingRows label={t('workspace.lib.loading')} rows={2} tall />}
      {load.state === 'error' && <ServiceNotice problem={load.problem} failure={load.failure} feature={t('workspace.lib.collections')} detail={t('workspace.lib.unavailableDetail')} onRetry={reload} />}
      {load.state === 'ready' && !current && (
        <>
          {collections.length > 0 && <LibrarySearch collections={collections} />}
          {collections.length === 0
            ? <EmptyState icon="bookOpen" title={t('workspace.lib.empty')} body={t('workspace.lib.emptyBody')}>
                <button type="button" className={u.buttonPrimary} onClick={() => setEditing({ mode: 'new' })}><Icon name="plus" size={15} />{t('workspace.lib.new')}</button>
              </EmptyState>
            : <ul className={s.grid}>
                {collections.map((col) => (
                  <li key={col.id} className={`${s.card} ${c.collection}`}>
                    <div className={s.cardHead}>
                      <span className={s.mark} aria-hidden="true"><Icon name="library" /></span>
                      <div className={c.cardText}><h3>{col.name}</h3>{col.description && <p>{col.description}</p>}</div>
                    </div>
                    <div className={s.tags}>
                      <Badge tone={col.visibility === 'organization' ? 'info' : 'neutral'}><Icon name={col.visibility === 'organization' ? 'globe' : 'lock'} size={12} />{t(col.visibility === 'organization' ? 'workspace.lib.visOrg' : 'workspace.lib.visPrivate')}</Badge>
                      <span className={c.updated}><When iso={col.updatedAt} prefix="workspace.lib.updated" /></span>
                    </div>
                    <div className={s.actions}>
                      <button type="button" className={u.button} onClick={() => setOpen(col.id)}>{t('workspace.lib.open')}<span className={u.sr}>: {col.name}</span></button>
                    </div>
                  </li>
                ))}
              </ul>}
        </>
      )}
      {current && (
        <CollectionPanel uploadScope={uploadScope} collection={current} onBack={() => setOpen(null)} onEdit={() => setEditing({ mode: 'edit', collection: current })}
          onDeleted={() => { update((v) => ({ collections: v.collections.filter((x) => x.id !== current.id) })); setOpen(null); setNotice(t('workspace.lib.deleted', { name: current.name })); }} />
      )}
      {editing && (
        <CollectionDialog editing={editing} onClose={() => setEditing(null)} onSaved={(col, created) => {
          update((v) => ({ collections: created ? [col, ...v.collections] : v.collections.map((x) => (x.id === col.id ? col : x)) }));
          setEditing(null);
          setNotice(t(created ? 'workspace.lib.created' : 'workspace.lib.saved', { name: col.name }));
          if (created) setOpen(col.id);
        }} />
      )}
    </section>
  );
}

function LibrarySearch({ collections }: { collections: readonly Collection[] }) {
  const t = useT();
  const id = useId();
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<string>('');
  const [state, setState] = useState<{ query: string; hits: readonly SearchHit[] } | { query: string; error: MessageKey } | { query: string; loading: true } | null>(null);
  async function go(e: React.FormEvent) {
    e.preventDefault();
    const query = q.trim();
    if (!query) { setState(null); return; }
    setState({ query, loading: true });
    const r = await workspaceApi().search(query, { collectionIds: scope ? [scope] : undefined, limit: 20 });
    if (r.ok && hasArray(r.value, 'hits')) setState({ query, hits: r.value.hits });
    else setState({ query, error: r.ok ? 'workspace.err.unavailable' : messageKeyFor(r) });
  }
  const name = (cid: string) => collections.find((x) => x.id === cid)?.name ?? '';
  return (
    <div className={c.search}>
      <form className={c.searchForm} onSubmit={go} role="search" aria-label={t('workspace.lib.searchLabel')}>
        <div className={s.searchRow}><Icon name="search" size={16} />
          <label htmlFor={id} className={u.sr}>{t('workspace.lib.searchLabel')}</label>
          <input id={id} type="search" value={q} maxLength={200} placeholder={t('workspace.lib.searchPlaceholder')} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className={u.sr} htmlFor={`${id}-scope`}>{t('workspace.lib.searchIn')}</label>
        <select id={`${id}-scope`} className={c.scope} value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">{t('workspace.lib.searchAll')}</option>
          {collections.map((col) => <option key={col.id} value={col.id}>{col.name}</option>)}
        </select>
        <button type="submit" className={u.button}>{t('workspace.lib.searchButton')}</button>
      </form>
      <div role="status" aria-live="polite">
        {state && 'loading' in state && <p className={s.muted}>{t('workspace.lib.searching')}</p>}
        {state && 'hits' in state && <p className={s.muted}>{t('workspace.lib.hits', { count: state.hits.length, query: state.query })}</p>}
      </div>
      {state && 'error' in state && <p className={u.fieldError} role="alert">{t(state.error)}</p>}
      {state && 'hits' in state && state.hits.length > 0 && (
        <ol className={c.hits}>
          {state.hits.map((h) => (
            <li key={h.chunkId}>
              <p className={c.hitTitle}><Icon name="file" size={14} /><strong>{h.title}</strong><span className={c.hitIn}>{name(h.collectionId)}</span></p>
              <p className={c.snippet}>{h.snippet}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

type Upload = { id: string; name: string; size: number; state: 'uploading' | 'failed'; percent?: number | null; message?: string };

function CollectionPanel({ collection: col, uploadScope, onBack, onEdit, onDeleted }: { uploadScope?: string; collection: Collection; onBack(): void; onEdit(): void; onDeleted(): void }) {
  const t = useT();
  const { load, reload, update } = useLoad<CollectionDetail>(`col:${col.id}`, () => workspaceApi().getCollection(col.id), (v) => hasArray(v, 'documents'));
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [confirm, setConfirm] = useState<{ kind: 'collection' } | { kind: 'document'; doc: LibraryDocument } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const pendingUploads = useRef(new Set<AbortController>());
  useEffect(() => { const pending = pendingUploads.current; return () => { for (const controller of pending) controller.abort(); }; }, []);
  const fileInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const docs = load.state === 'ready' ? load.value.documents : [];
  const indexing = docs.some((d) => d.status === 'pending' || d.status === 'indexing');

  useEffect(() => { heading.current?.focus(); }, []);
  // While documents are being indexed, check again every few seconds.
  useEffect(() => {
    if (!indexing) return;
    const timer = setTimeout(reload, POLL_MS);
    return () => clearTimeout(timer);
  }, [indexing, reload, load]);

  async function add(list: FileList | File[] | null) {
    if (!uploadScope) { setMessage(t('workspace.err.storage')); return; }
    const files = [...(list ?? [])];
    const refused: string[] = [];
    for (const f of files) {
      if (!isUploadable(f.name)) { refused.push(`${f.name}: ${t('workspace.upload.refusedType')}`); continue; }
      if (f.size === 0) { refused.push(`${f.name}: ${t('workspace.files.refusedEmpty')}`); continue; }
      if (f.size > UPLOAD_MAX_BYTES) { refused.push(`${f.name}: ${t('workspace.upload.refusedSize', { max: formatBytes(UPLOAD_MAX_BYTES, t.locale) })}`); continue; }
      const id = `${f.name}:${f.size}:${Math.random().toString(36).slice(2, 8)}`;
      setUploads((x) => [...x, { id, name: f.name, size: f.size, state: 'uploading' }]);
      void (async () => {
        const controller = new AbortController(); pendingUploads.current.add(controller);
        let fileId: string | null = null;
        try {
          const up = await uploadSafely(f, mediaTypeFor(f), uploadScope, controller.signal, percent => {
            if (!controller.signal.aborted) setUploads(x => x.map(y => y.id === id ? { ...y, percent } : y));
          }, workspaceApi(), localStorage, col.visibility);
          if (controller.signal.aborted) return;
          if (up.kind === 'stored' || up.kind === 'existing') fileId = up.file.id;
        } catch { /* No automatic replay after a failed verification or upload. */ }
        finally { pendingUploads.current.delete(controller); }
        if (!fileId) {
          const msg = t.locale === 'es' ? 'Subida no confirmada. Vuelva a seleccionar el mismo archivo para comprobarlo; no se reenviará una subida sin resolver.' : 'Upload not confirmed. Reselect the same file to check it; unresolved uploads will not be resent.';
          setUploads(x => x.map(y => y.id === id ? { ...y, state: 'failed', message: msg } : y));
          return;
        }
        const added = await workspaceApi().addDocument(col.id, fileId, f.name);
        if (added.ok && added.value?.document) {
          const doc = added.value.document;
          setUploads((x) => x.filter((y) => y.id !== id));
          update((v) => ({ ...v, documents: [doc, ...v.documents.filter((d) => d.id !== doc.id)] }));
          setMessage(t(added.value.created === false ? 'workspace.lib.reused' : 'workspace.lib.added', { name: doc.title }));
        } else {
          setUploads((x) => x.map((y) => (y.id === id ? { ...y, state: 'failed', message: `${t('workspace.lib.addUnconfirmed')} ${t(added.ok ? 'workspace.err.generic' : messageKeyFor(added))}` } : y)));
        }
      })();
    }
    setMessage(refused.length ? refused.join(' ') : null);
  }

  async function reindex(doc: LibraryDocument) {
    const r = await workspaceApi().reindexDocument(col.id, doc.id);
    if (r.ok && r.value?.document) { const next = r.value.document; update((v) => ({ ...v, documents: v.documents.map((d) => (d.id === next.id ? next : d)) })); setMessage(t('workspace.lib.reindexing', { name: doc.title })); }
    else setMessage(t(r.ok ? 'workspace.err.generic' : messageKeyFor(r)));
  }

  return (
    <div className={c.panel}>
      <div className={c.panelHead}>
        <button type="button" className={u.buttonGhost} onClick={reload}>{t('workspace.refresh')}</button>
        <button type="button" className={u.buttonGhost} onClick={onBack}><Icon name="arrowLeft" size={15} />{t('workspace.lib.back')}</button>
        <div className={c.panelTitle}>
          <h3 ref={heading} tabIndex={-1}>{col.name}</h3>
          {col.description && <p>{col.description}</p>}
        </div>
        <Badge tone={col.visibility === 'organization' ? 'info' : 'neutral'}>{t(col.visibility === 'organization' ? 'workspace.lib.visOrg' : 'workspace.lib.visPrivate')}</Badge>
        {col.ownedByMe && <ActionMenu label={t('workspace.lib.options', { name: col.name })} actions={[
          { key: 'edit', label: t('workspace.lib.edit'), icon: 'pencil', onSelect: onEdit },
          { key: 'delete', label: t('workspace.lib.delete'), icon: 'trash', danger: true, separated: true, onSelect: () => setConfirm({ kind: 'collection' }) },
        ]} />}
      </div>

      <div className={`${u.drop} ${dragging ? u.dropActive : ''}`}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void add(e.dataTransfer.files); }}>
        <Icon name="upload" size={20} />
        <p>{t('workspace.lib.dropHint')}</p>
        <input ref={fileInput} type="file" multiple accept={LIBRARY_ACCEPT} className={u.sr} tabIndex={-1} aria-hidden="true" onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
        <button type="button" className={u.button} onClick={() => fileInput.current?.click()}><Icon name="upload" size={15} />{t('workspace.lib.upload')}</button>
        <p className={u.help}>{t('workspace.lib.formats', { max: formatBytes(UPLOAD_MAX_BYTES, t.locale) })}</p>
      </div>

      <div role="status" aria-live="polite" className={c.live}>{message && <p className={c.inline}>{message}</p>}</div>

      {uploads.length > 0 && (
        <ul className={u.uploads} aria-label={t('workspace.upload.listLabel')}>
          {uploads.map((x) => (
            <li key={x.id} className={u.upload}>
              <Icon name={x.state === 'failed' ? 'alert' : 'upload'} size={15} />
              <strong title={x.name}>{x.name}</strong>
              {x.state === 'failed'
                ? <button type="button" className={u.iconButton} onClick={() => setUploads((l) => l.filter((y) => y.id !== x.id))} aria-label={t('workspace.files.remove', { name: x.name })}><Icon name="close" size={14} /></button>
                : <small>{formatBytes(x.size, t.locale)}</small>}
              {x.state === 'uploading' ? <span><progress aria-label={x.name} max={100} value={x.percent ?? undefined} />{x.percent != null && <small>{x.percent}% {x.percent === 100 ? (t.locale === 'es' ? 'Confirmando almacenamiento…' : 'Confirming storage…') : ''}</small>}</span> : <small className={c.failMsg}>{x.message}</small>}
            </li>
          ))}
        </ul>
      )}

      {load.state === 'loading' && <LoadingRows label={t('workspace.lib.loadingDocs')} rows={3} />}
      {load.state === 'error' && <ServiceNotice problem={load.problem} failure={load.failure} feature={t('workspace.lib.documents')} onRetry={reload} compact />}
      {load.state === 'ready' && (docs.length === 0
        ? <p className={s.muted}>{t('workspace.lib.noDocs')}</p>
        : <div className={c.tableWrap}>
            <table className={c.table}>
              <caption className={u.sr}>{t('workspace.lib.docsCaption', { name: col.name })}</caption>
              <thead><tr><th scope="col">{t('workspace.lib.doc')}</th><th scope="col">{t('workspace.lib.status')}</th><th scope="col" className={c.hideNarrow}>{t('workspace.lib.indexed')}</th><th scope="col"><span className={u.sr}>{t('workspace.lib.actions')}</span></th></tr></thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <th scope="row"><span className={c.docName}><Icon name="file" size={15} /><span title={d.title}>{d.title}</span></span></th>
                    <td>
                      <Badge tone={STATUS_TONE[d.status]}>{t(`workspace.lib.st.${d.status}`)}</Badge>
                      {(d.status === 'pending' || d.status === 'indexing') && <p className={c.docMeta}>{t(d.status === 'pending' ? 'workspace.lib.pendingHelp' : 'workspace.lib.indexingHelp')}</p>}
                      {(d.status === 'failed' || d.status === 'unsupported') && <p className={c.docError}>{t(DOC_ERRORS[d.errorCode ?? ''] ?? 'workspace.lib.err.generic')}</p>}
                      {d.status === 'ready' && <p className={c.docMeta}>{t('workspace.lib.chunks', { count: d.chunkCount })}</p>}
                    </td>
                    <td className={c.hideNarrow}>{d.indexedAt ? <When iso={d.indexedAt} /> : '—'}</td>
                    <td className={c.rowActions}>
                      <ActionMenu label={t('workspace.lib.docOptions', { name: d.title })} actions={[
                        { key: 'download', label: t('workspace.lib.download'), icon: 'download', onSelect: () => { window.location.href = workspaceApi().fileContentUrl(d.fileId); } },
                        { key: 'reindex', label: t('workspace.lib.reindex'), icon: 'refresh', onSelect: () => void reindex(d) },
                        { key: 'remove', label: t('workspace.lib.remove'), icon: 'trash', danger: true, separated: true, onSelect: () => setConfirm({ kind: 'document', doc: d }) },
                      ]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>)}

      {confirm && (
        <ConfirmDelete
          title={confirm.kind === 'collection' ? t('workspace.lib.deleteTitle', { name: col.name }) : t('workspace.lib.removeTitle', { name: confirm.doc.title })}
          body={confirm.kind === 'collection' ? t('workspace.lib.deleteBody') : t('workspace.lib.removeBody')}
          confirm={confirm.kind === 'collection' ? t('workspace.lib.deleteConfirm') : t('workspace.lib.removeConfirm')}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            if (confirm.kind === 'collection') { const r = await workspaceApi().deleteCollection(col.id); if (r.ok) onDeleted(); return r.ok ? null : messageKeyFor(r); }
            const doc = confirm.doc;
            const r = await workspaceApi().removeDocument(col.id, doc.id);
            if (r.ok) { update((v) => ({ ...v, documents: v.documents.filter((x) => x.id !== doc.id) })); setMessage(t('workspace.lib.removed', { name: doc.title })); }
            return r.ok ? null : messageKeyFor(r);
          }} />
      )}
    </div>
  );
}

function ConfirmDelete({ title, body, confirm, onClose, onConfirm }: { title: string; body: string; confirm: string; onClose(): void; onConfirm(): Promise<MessageKey | null> }) {
  const t = useT();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  return (
    <Dialog tone="alert" title={title} description={body} onClose={onClose} footer={<>
      <button type="button" className={u.button} onClick={onClose} data-autofocus>{t('workspace.cancel')}</button>
      <button type="button" className={u.buttonDanger} disabled={working} onClick={async () => { setWorking(true); const e = await onConfirm(); setWorking(false); if (e) setError(e); else onClose(); }}>{working ? t('workspace.working') : confirm}</button>
    </>}>
      {error && <p className={u.fieldError} role="alert">{t(error)}</p>}
    </Dialog>
  );
}

function CollectionDialog({ editing, onClose, onSaved }: { editing: NonNullable<Editing>; onClose(): void; onSaved(c: Collection, created: boolean): void }) {
  const t = useT();
  const start = editing.mode === 'edit' ? editing.collection : null;
  const [name, setName] = useState(start?.name ?? '');
  const [description, setDescription] = useState(start?.description ?? '');
  const [visibility, setVisibility] = useState<FileVisibility>(start?.visibility ?? 'private');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const id = useId();
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim(); if (!n) return;
    setSaving(true); setError(null);
    const d = description.trim();
    const r = start
      ? await workspaceApi().updateCollection(start.id, { name: n, description: d || null, visibility })
      : await workspaceApi().createCollection({ name: n, ...(d ? { description: d } : {}), visibility });
    setSaving(false);
    if (r.ok && r.value?.collection) onSaved(r.value.collection, !start);
    else setError(r.ok ? 'workspace.err.generic' : messageKeyFor(r));
  }
  return (
    <Dialog title={start ? t('workspace.lib.editTitle') : t('workspace.lib.newTitle')} onClose={onClose}>
      <form onSubmit={save} className={u.dialogBody}>
        <label className={u.field} htmlFor={`${id}-n`}><span>{t('workspace.lib.name')}</span>
          <input id={`${id}-n`} value={name} maxLength={NAME_MAX} required onChange={(e) => setName(e.target.value)} /></label>
        <label className={u.field} htmlFor={`${id}-d`}><span>{t('workspace.lib.description')}</span>
          <textarea id={`${id}-d`} value={description} maxLength={DESC_MAX} rows={3} onChange={(e) => setDescription(e.target.value)} />
          <span className={u.counter} aria-hidden="true">{description.length}/{DESC_MAX}</span></label>
        <fieldset className={u.choices}>
          <legend>{t('workspace.lib.visibility')}</legend>
          <label className={u.choice}><input type="radio" name="vis" checked={visibility === 'private'} onChange={() => setVisibility('private')} /><span>{t('workspace.lib.visPrivate')}<small>{t('workspace.lib.visPrivateHelp')}</small></span></label>
          <label className={u.choice}><input type="radio" name="vis" checked={visibility === 'organization'} onChange={() => setVisibility('organization')} /><span>{t('workspace.lib.visOrg')}<small>{t('workspace.lib.visOrgHelp')}</small></span></label>
        </fieldset>
        {start && start.visibility !== visibility && <p className={u.help}>{t('workspace.lib.visChange')}</p>}
        {error && <p className={u.fieldError} role="alert">{t(error)}</p>}
        <div className={u.dialogFoot}>
          <button type="button" className={u.button} onClick={onClose}>{t('workspace.cancel')}</button>
          <button type="submit" className={u.buttonPrimary} disabled={!name.trim() || saving}>{saving ? t('workspace.saving') : start ? t('workspace.save') : t('workspace.create')}</button>
        </div>
      </form>
    </Dialog>
  );
}
