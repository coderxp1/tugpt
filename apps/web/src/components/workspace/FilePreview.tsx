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

type Preview = { kind: 'loading' | 'error' } | { kind: 'text' | 'image'; body: string };

/** Authenticated previews only. No HTML, SVG, embedded documents or remote image URLs. */
export function FilePreview({ file, url }: { file: WorkspaceFile; url: string }) {
  const t = useT(); const es = t.locale === 'es';
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Preview>({ kind: 'loading' });
  useEffect(() => {
    const controller = new AbortController(); let objectUrl: string | undefined;
    void (async () => {
      const kind = previewKind(file);
      if (!kind) throw new Error('Unsupported preview');
      const limit = (kind === 'text' ? 1 : 8) * 1024 * 1024;
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok || Number(response.headers.get('content-length')) > limit) throw new Error('Preview unavailable');
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
    {state.kind === 'loading' && <p role="status">{es ? 'Cargando vista previa…' : 'Loading preview…'}</p>}
    {state.kind === 'error' && <div><p role="alert">{es ? 'Vista previa no disponible. Descargue el archivo.' : 'Preview unavailable. Download the file instead.'}</p><button className={u.button} onClick={() => { setState({ kind: 'loading' }); setAttempt((n) => n + 1); }}>{es ? 'Reintentar vista previa' : 'Retry preview'}</button></div>}
    {state.kind === 'text' && <pre className={f.preview}>{state.body}</pre>}
    {state.kind === 'image' && /* The source is an authenticated, bounded local blob, not an optimizable URL. */
      // eslint-disable-next-line @next/next/no-img-element
      <img className={f.imagePreview} src={state.body} alt={file.filename} onError={() => setState({ kind: 'error' })} />}
    <a className={u.button} href={url} download>{es ? 'Descargar' : 'Download'}</a>
  </>;
}
