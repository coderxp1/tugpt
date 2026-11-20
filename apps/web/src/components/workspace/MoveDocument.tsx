'use client';
import { useRef, useState } from 'react';
import type { Collection, LibraryDocument } from '@/lib/workspace-data/contracts';
import { workspaceApi, hasArray } from '@/lib/workspace/service';
import { useT } from '@/i18n/provider';
import { useLoad } from './useLoad';
import { Dialog } from './Dialog';
import u from './ui.module.css';

/** Confirm destination registration before removing the source link; never delete the file itself. */
export function MoveDocument({ source, document, onClose, onMoved }: { source: Collection; document: LibraryDocument; onClose(): void; onMoved(): void }) {
  const t = useT(); const es = t.locale === 'es'; const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false); const lock = useRef(false); const [error, setError] = useState('');
  const { load, reload } = useLoad('move-targets', () => workspaceApi().listCollections(), v => hasArray(v, 'collections'));
  const targets = load.state === 'ready' ? load.value.collections.filter(c => c.ownedByMe && c.id !== source.id && c.visibility === source.visibility) : [];
  async function move() {
    if (lock.current || !targets.some(c => c.id === target)) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const added = await workspaceApi().addDocument(target, document.fileId, document.title);
      if (!added.ok || !added.value.document?.id) { setError(es ? 'No se confirmó el destino. El documento original no se ha eliminado.' : 'Destination not confirmed. The original document has not been removed.'); return; }
      const removed = await workspaceApi().removeDocument(source.id, document.id);
      if (!removed.ok) { setError(es ? 'El destino está guardado. No se confirmó la eliminación del origen; actualice ambas colecciones antes de reintentar.' : 'Destination saved. Source removal was not confirmed; refresh both collections before retrying.'); return; }
      onMoved();
    } finally { lock.current = false; setBusy(false); }
  }
  return <Dialog title={es ? 'Mover documento' : 'Move document'} onClose={() => { if (!lock.current) onClose(); }}>
    <p>{document.title}</p><p>{es ? 'Solo se muestran sus colecciones con la misma visibilidad. El destino se indexará por separado; las citas anteriores pueden dejar de estar disponibles.' : 'Only your collections with the same visibility are shown. The destination is indexed separately; earlier citations may become unavailable.'}</p>
    {load.state === 'loading' && <p role="status">{es ? 'Cargando…' : 'Loading collections…'}</p>}
    {load.state === 'error' && <button className={u.button} onClick={reload}>{es ? 'Reintentar' : 'Retry loading collections'}</button>}
    <label className={u.field}>{es ? 'Colección de destino' : 'Destination collection'}<select disabled={busy} value={target} onChange={e => setTarget(e.target.value)}><option value="">{es ? 'Seleccione una colección' : 'Choose a collection'}</option>{targets.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
    {load.state === 'ready' && !targets.length && <p>{es ? 'Cree primero otra colección con la misma visibilidad.' : 'Create another collection with the same visibility first.'}</p>}
    {error && <p role="alert">{error}</p>}
    <div className={u.dialogFoot}><button className={u.button} disabled={busy} onClick={onClose}>{es ? 'Cancelar' : 'Cancel'}</button><button className={u.buttonPrimary} disabled={busy || !target} onClick={() => void move()}>{busy ? (es ? 'Moviendo…' : 'Moving…') : (es ? 'Mover' : 'Move')}</button></div>
  </Dialog>;
}
