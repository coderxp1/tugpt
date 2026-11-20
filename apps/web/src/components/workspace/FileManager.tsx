'use client';

import { useRef, useState } from 'react';
import { useT } from '@/i18n/provider';
import type { WorkspaceFile } from '@/lib/workspace-data/contracts';
import { hasArray, messageKeyFor, workspaceApi } from '@/lib/workspace/service';
import { UPLOAD_ACCEPT, UPLOAD_MAX_BYTES, formatBytes, isUploadable, mediaTypeFor } from '@/lib/workspace/uploads';
import { FilePreview, previewKind } from './FilePreview';
import { Dialog } from './Dialog';
import { LoadingRows, ServiceNotice } from './states';
import { useLoad } from './useLoad';
import s from './pages.module.css';
import u from './ui.module.css';
import f from './files.module.css';

const words = {
  en: { title: 'Files', mine: 'My files', org: 'Shared with organization', scope: 'File scope', filter: 'Filter this page by filename', upload: 'Upload private file', uploading: 'Uploading — please keep this page open', ready: 'Stored', failed: 'Upload failed. Select the original file to try again.', empty: 'No matching files on this page.', refresh: 'Refresh files', next: 'Next page', first: 'First page', rename: 'Rename', remove: 'Delete', preview: 'Preview text', download: 'Download', name: 'Filename (keep the extension)', save: 'Save', cancel: 'Cancel', confirm: 'Delete this file?', warning: 'This removes the file and can affect linked chats and knowledge collections. This cannot be undone.', help: 'PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), text and images, up to 25 MB. Stored does not mean indexed or readable by the assistant. Manage indexing in Knowledge collections.', loading: 'Loading preview…', previewError: 'Preview unavailable. Download the file instead.', unsupported: 'Choose a supported, non-empty file of up to 25 MB.', saved: 'File saved.', deleted: 'File deleted.', previewNote: 'Plain-text preview, up to 1 MB. Content is never executed.', linking: 'Add to collection', collection: 'Choose your collection', added: 'Added to collection. Check processing status in Knowledge collections.', readOnly: 'Read-only access. File changes are not available for this role.' },
  es: { title: 'Archivos', mine: 'Mis archivos', org: 'Compartidos con la organización', scope: 'Ámbito de archivos', filter: 'Filtrar esta página por nombre', upload: 'Subir archivo privado', uploading: 'Subiendo — mantenga esta página abierta', ready: 'Almacenado', failed: 'Error al subir. Seleccione el archivo original para volver a intentarlo.', empty: 'No hay archivos coincidentes en esta página.', refresh: 'Actualizar archivos', next: 'Página siguiente', first: 'Primera página', rename: 'Renombrar', remove: 'Eliminar', preview: 'Vista previa de texto', download: 'Descargar', name: 'Nombre del archivo (conserve la extensión)', save: 'Guardar', cancel: 'Cancelar', confirm: '¿Eliminar este archivo?', warning: 'Esto elimina el archivo y puede afectar a los chats y colecciones vinculados. No se puede deshacer.', help: 'PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), texto e imágenes, hasta 25 MB. Almacenado no significa indexado ni legible por el asistente. Gestione la indexación en Colecciones de conocimiento.', loading: 'Cargando vista previa…', previewError: 'Vista previa no disponible. Descargue el archivo.', unsupported: 'Elija un archivo compatible, no vacío, de hasta 25 MB.', saved: 'Archivo guardado.', deleted: 'Archivo eliminado.', previewNote: 'Vista previa de texto sin formato, hasta 1 MB. El contenido nunca se ejecuta.', linking: 'Añadir a colección', collection: 'Elija su colección', added: 'Añadido a la colección. Consulte el procesamiento en Colecciones de conocimiento.', readOnly: 'Acceso de solo lectura. Este rol no permite modificar archivos.' },
};
type Action = { file: WorkspaceFile; kind: 'rename' | 'delete' | 'preview' | 'link' } | null;

export function FileManager({ role }: { role?: string }) {
  const t = useT(); const text = words[t.locale === 'es' ? 'es' : 'en'];
  const writable = ['owner', 'admin', 'manager', 'agent'].includes(role ?? '');
  const [scope, setScope] = useState<'mine' | 'organization'>('mine');
  const [cursor, setCursor] = useState<string | undefined>();
  const [query, setQuery] = useState('');
  const [action, setAction] = useState<Action>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false); const lock = useRef(false);
  const [notice, setNotice] = useState(''); const [error, setError] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const api = workspaceApi();
  const { load, reload } = useLoad(`${scope}:${cursor ?? ''}`, () => api.listFiles({ scope, before: cursor, limit: 20 }), (v) => hasArray(v, 'files'));
  const collections = useLoad(action?.kind === 'link' ? action.file.id : null, () => api.listCollections(), (v) => hasArray(v, 'collections'));
  function open(file: WorkspaceFile, kind: NonNullable<Action>['kind']) { setError(''); setName(file.filename); setCollectionId(''); setAction({ file, kind }); }
  async function upload(file?: File) {
    if (!file || lock.current || !writable) return;
    if (!isUploadable(file.name) || !file.size || file.size > UPLOAD_MAX_BYTES) { setError(text.unsupported); return; }
    lock.current = true; setBusy(true); setError(''); setNotice(text.uploading);
    try {
      const r = await api.uploadFile(file.slice(0, file.size, mediaTypeFor(file)), file.name, 'private');
      if (!r.ok) { setError(t(messageKeyFor(r))); setNotice(''); }
      else { setNotice(text.saved); setScope('mine'); setCursor(undefined); reload(); }
    } finally { lock.current = false; setBusy(false); }
  }
  async function mutate() {
    if (!action || lock.current || !writable) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const r = action.kind === 'delete' ? await api.deleteFile(action.file.id)
        : action.kind === 'link' ? await api.addDocument(collectionId, action.file.id)
        : await api.renameFile(action.file.id, name);
      if (!r.ok) setError(t(messageKeyFor(r)));
      else { setNotice(action.kind === 'delete' ? text.deleted : action.kind === 'link' ? text.added : text.saved); setAction(null); reload(); }
    } finally { lock.current = false; setBusy(false); }
  }
  return <section className={`${s.section} ${f.manager}`} aria-labelledby="workspace-files-title">
    <h2 id="workspace-files-title">{text.title}</h2><p className={s.muted}>{text.help}</p>
    {!writable && <p>{text.readOnly}</p>}
    <div className={f.controls}>
      <label className={u.field}>{text.scope}<select value={scope} disabled={busy} onChange={(e) => { setScope(e.target.value as typeof scope); setCursor(undefined); }}><option value="mine">{text.mine}</option><option value="organization">{text.org}</option></select></label>
      <label className={u.field}>{text.filter}<input type="search" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      <button className={u.button} disabled={busy} onClick={reload}>{text.refresh}</button>
      {writable && <label className={u.field}>{text.upload}<input type="file" accept={UPLOAD_ACCEPT} disabled={busy} onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} /></label>}
    </div>
    <p role="status">{notice}</p>{busy && <progress aria-label={text.title} />}
    {error && !action && <p className={u.error} role="alert">{error}</p>}
    {load.state === 'loading' && <LoadingRows label={text.title} rows={2} />}
    {load.state === 'error' && <ServiceNotice problem={load.problem} failure={load.failure} feature={text.title} onRetry={reload} />}
    {load.state === 'ready' && <>
      <ul className={f.list}>{load.value.files.filter((file) => file.filename.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((file) => <li key={file.id}>
        <strong>{file.filename}</strong><p>{formatBytes(file.sizeBytes, t.locale)} · {file.visibility === 'private' ? t('workspace.lib.visPrivate') : t('workspace.lib.visOrg')} · {file.status === 'ready' ? text.ready : file.status === 'failed' ? text.failed : text.uploading}</p>
        <div className={f.controls}>
          {file.status === 'ready' && <a className={u.button} href={api.fileContentUrl(file.id)} download>{text.download}</a>}
          {file.status === 'ready' && previewKind(file) && <button className={u.button} onClick={() => open(file, 'preview')}>{previewKind(file) === 'image' ? (t.locale === 'es' ? 'Vista previa de imagen' : 'Preview image') : text.preview}</button>}
          {writable && file.ownedByMe && <><button className={u.button} disabled={busy} onClick={() => open(file, 'rename')}>{text.rename}</button>{file.status === 'ready' && <button className={u.button} disabled={busy} onClick={() => open(file, 'link')}>{text.linking}</button>}</>}
          {writable && (file.ownedByMe || (file.visibility === 'organization' && ['owner', 'admin'].includes(role ?? ''))) && <button className={u.button} disabled={busy} onClick={() => open(file, 'delete')}>{text.remove}</button>}
        </div>
      </li>)}</ul>
      {!load.value.files.some((file) => file.filename.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && <p>{text.empty}</p>}
      <div className={f.controls}>{cursor && <button className={u.button} onClick={() => setCursor(undefined)}>{text.first}</button>}{load.value.nextCursor && <button className={u.button} onClick={() => setCursor(load.value.nextCursor ?? undefined)}>{text.next}</button>}</div>
    </>}
    {action && <Dialog title={action.kind === 'delete' ? text.confirm : action.kind === 'rename' ? text.rename : action.kind === 'link' ? text.linking : previewKind(action.file) === 'image' ? (t.locale === 'es' ? 'Vista previa de imagen' : 'Preview image') : text.preview} tone={action.kind === 'delete' ? 'alert' : 'default'} onClose={() => { if (!busy) { setAction(null); setError(''); } }} footer={action.kind !== 'preview' && <><button className={u.button} disabled={busy} onClick={() => setAction(null)}>{text.cancel}</button><button className={action.kind === 'delete' ? u.buttonDanger : u.buttonPrimary} disabled={busy || (action.kind === 'rename' && !name.trim()) || (action.kind === 'link' && !collectionId)} onClick={() => void mutate()}>{action.kind === 'delete' ? text.remove : text.save}</button></>}>
      <p className={f.filename}>{action.file.filename}</p>
      {action.kind === 'delete' && <p>{text.warning}</p>}
      {action.kind === 'rename' && <label className={u.field}>{text.name}<input maxLength={240} value={name} onChange={(e) => setName(e.target.value)} /></label>}
      {action.kind === 'preview' && <FilePreview key={action.file.id} file={action.file} url={api.fileContentUrl(action.file.id)} />}
      {action.kind === 'link' && <>{collections.load.state === 'error' && <ServiceNotice problem={collections.load.problem} failure={collections.load.failure} feature={text.collection} onRetry={collections.reload} />}<label className={u.field}>{text.collection}<select value={collectionId} onChange={(e) => setCollectionId(e.target.value)}><option value="">{text.collection}</option>{collections.load.state === 'ready' && collections.load.value.collections.filter((c) => c.ownedByMe).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label></>}
      {error && <p className={u.error} role="alert">{error}</p>}
    </Dialog>}
  </section>;
}
