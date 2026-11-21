'use client';

import { useEffect, useState } from 'react';
import type { WorkspaceFile } from '@/lib/workspace-data/contracts';
import { useT } from '@/i18n/provider';
import u from './ui.module.css';
import f from './files.module.css';

export function previewKind(file: Pick<WorkspaceFile, 'mediaType' | 'sizeBytes'>): 'text' | 'image' | null {
  if (file.sizeBytes <= 1024 * 1024 && /^(text\/|application\/json$)/.test(file.mediaType)) return 'text';
  if (file.sizeBytes <= 8 * 1024 * 1024 && /^image\/(png|jpeg|gif|webp)$/.test(file.mediaType)) return 'image';
  return null;
}

type Preview = { kind: 'loading' | 'error' | 'unsupported' } | { kind: 'text' | 'image'; body: string };

/** Authenticated previews only. No HTML, SVG, embedded documents or remote image URLs. */
export function FilePreview({ file, url }: { file: WorkspaceFile; url: string }) {
  const t = useT(); const es = t.locale === 'es';
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Preview>({ kind: previewKind(file) ? 'loading' : 'unsupported' });
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); let objectUrl: string | undefined;
    void (async () => {
      const kind = previewKind(file);
      if (!kind) return;
      const limit = (kind === 'text' ? 1 : 8) * 1024 * 1024;
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok || Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('Preview unavailable'); }
      // Bound the bytes consumed even when Content-Length is absent or inaccurate.
      if (!response.body) throw new Error('Missing response body');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > limit) { await reader.cancel(); throw new Error('Preview too large'); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      if (controller.signal.aborted) return;
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      if (kind === 'text') setState({ kind, body: new TextDecoder().decode(bytes) });
      else {
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: file.mediaType }));
        setState({ kind, body: objectUrl });
      }
    })().catch(() => { if (!controller.signal.aborted) setState({ kind: 'error' }); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [file, url, attempt]);
  return <>
    <p>{es ? 'Vista previa solamente. No confirma que el asistente pueda buscar o leer este archivo.' : 'Preview only. This does not confirm that the assistant can search or read this file.'}</p>
    {state.kind === 'unsupported' && <p role="status">{es ? 'No hay vista previa para este formato o tamaño. Descargue el archivo para abrirlo en una aplicación compatible.' : 'Preview is not available for this format or size. Download the file to open it in a compatible application.'}</p>}
    {state.kind === 'loading' && <p role="status">{es ? 'Cargando vista previa…' : 'Loading preview…'}</p>}
    {state.kind === 'error' && <div><p role="alert">{es ? 'Vista previa no disponible. Descargue el archivo.' : 'Preview unavailable. Download the file instead.'}</p><button className={u.button} onClick={() => { setState({ kind: 'loading' }); setAttempt((n) => n + 1); }}>{es ? 'Reintentar vista previa' : 'Retry preview'}</button></div>}
    {state.kind === 'text' && <pre className={f.preview}>{state.body}</pre>}
    {state.kind === 'image' && <>
      <div className={f.previewTools}><button className={u.button} aria-pressed={zoom} onClick={() => setZoom(v => !v)}>{zoom ? (es ? 'Ajustar al ancho' : 'Fit width') : (es ? 'Ampliar' : 'Zoom in')}</button><span>{es ? 'Desplace la imagen para ver los detalles.' : 'Scroll the image to inspect details.'}</span></div>
      <div className={f.imageViewport} tabIndex={0} role="region" aria-label={es ? 'Imagen ampliable' : 'Scrollable image preview'}>
        {/* Authenticated local blob; no remote optimizer or third-party viewer. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={`${f.imagePreview} ${zoom ? f.imageZoom : ''}`} src={state.body} alt={file.filename} onError={() => setState({ kind: 'error' })} />
      </div>
    </>}
    <a className={u.button} href={url} download>{es ? 'Descargar' : 'Download'}</a>
  </>;
}
