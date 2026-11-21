'use client';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/provider';
import { workspaceApi } from '@/lib/workspace/service';
import { uploadSafely } from '@/lib/workspace/file-upload';
import { UPLOAD_ACCEPT, UPLOAD_MAX_BYTES, isUploadable, mediaTypeFor } from '@/lib/workspace/uploads';
import u from './ui.module.css';

export function FileUpload({ recoveryScope, onStored }: { recoveryScope?: string; onStored(): void }) {
  const t = useT(); const es = t.locale === 'es';
  const [busy, setBusy] = useState(false); const [percent, setPercent] = useState<number | null>(null);
  const [status, setStatus] = useState(''); const [retry, setRetry] = useState<'check' | 'retry' | null>(null);
  const active = useRef<AbortController | null>(null); const original = useRef<File | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function upload(file?: File) {
    if (!file || active.current || !recoveryScope) return;
    if (!isUploadable(file.name) || !file.size || file.size > UPLOAD_MAX_BYTES) { setStatus(es ? 'Elija un archivo compatible de hasta 25 MB.' : 'Choose a supported, non-empty file of up to 25 MB.'); return; }
    const controller = new AbortController(); active.current = controller; original.current = file;
    setBusy(true); setPercent(null); setRetry(null); setStatus(es ? 'Comprobando archivos guardados…' : 'Checking saved files…');
    try {
      const result = await uploadSafely(file, mediaTypeFor(file), recoveryScope, controller.signal, p => {
        if (controller.signal.aborted) return;
        setPercent(p); setStatus(p === 100 ? (es ? 'Transferencia completa. Confirmando almacenamiento…' : 'Transfer complete. Confirming storage…') : (es ? 'Subiendo archivo…' : 'Uploading file…'));
      }, workspaceApi());
      if (controller.signal.aborted) return;
      if (result.kind === 'stored' || result.kind === 'existing') {
        setStatus(result.kind === 'existing' ? (es ? 'Archivo guardado encontrado. No se ha subido otra copia.' : 'Saved file found. No duplicate was uploaded.') : (es ? 'Archivo guardado. Aún no está indexado.' : 'File stored. Not yet indexed.'));
        original.current = null; onStored();
      } else if (result.kind === 'failed') {
        setStatus(es ? 'La subida fue rechazada. Puede volver a intentarlo.' : 'Upload was rejected. You can try again.'); setRetry('retry');
      } else {
        setStatus(es ? 'No se pudo confirmar la subida. Compruebe los archivos guardados; no volveremos a subirlo mientras siga sin confirmarse.' : 'Upload not confirmed. Check saved files; we will not resend an unresolved upload.'); setRetry('check');
      }
    } catch { if (!controller.signal.aborted) { setStatus(es ? 'No se pudo verificar el archivo. No se volverá a enviar automáticamente.' : 'Could not verify the file. It will not be sent again automatically.'); setRetry('check'); } }
    finally { active.current = null; if (!controller.signal.aborted) setBusy(false); }
  }
  return <div>
    <label className={u.field}>{es ? 'Subir archivo privado' : 'Upload private file'}<input type="file" accept={UPLOAD_ACCEPT} disabled={busy || !recoveryScope} onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }} /></label>
    <p role="status">{status}</p>
    {busy && <progress aria-label={es ? 'Progreso de subida' : 'Upload progress'} max={100} value={percent ?? undefined} />}
    {busy && percent !== null && <span aria-hidden="true"> {percent}%</span>}
    {retry && <button className={u.button} disabled={busy} onClick={() => void upload(original.current ?? undefined)}>{retry === 'check' ? (es ? 'Comprobar archivo guardado' : 'Check saved upload') : (es ? 'Reintentar subida' : 'Retry upload')}</button>}
    <p>{es ? 'Si se interrumpe, vuelva a seleccionar el mismo archivo en este navegador para comprobarlo. No cierre esta pestaña durante la subida.' : 'If interrupted, reselect the same file in this browser to check it. Keep this tab open during upload.'}</p>
  </div>;
}
