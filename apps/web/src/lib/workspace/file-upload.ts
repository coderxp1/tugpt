import { createWorkspaceClient, type WorkspaceClient, type WorkspaceFile, type FileVisibility } from '@/lib/workspace-data/contracts';

export type UploadOutcome = { kind: 'stored' | 'existing'; file: WorkspaceFile } | { kind: 'uncertain' | 'failed' | 'unavailable' };

/** An upload-only transport adapter: retain the contract client's CSRF/auth/error handling. */
export function uploadTransport(signal: AbortSignal, progress: (percent: number | null) => void) {
  return (url: string, init?: RequestInit): Promise<Response> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Aborted')); return; }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => signal.removeEventListener('abort', abort);
    xhr.open(init?.method ?? 'POST', url); xhr.timeout = 120000;
    new Headers(init?.headers).forEach((value, key) => xhr.setRequestHeader(key, value));
    xhr.upload.onprogress = (e) => progress(e.lengthComputable ? Math.min(100, Math.round(e.loaded / e.total * 100)) : null);
    xhr.onload = () => { cleanup(); resolve(new Response(xhr.status === 204 ? null : xhr.responseText, { status: xhr.status, headers: { 'content-type': 'application/json' } })); };
    xhr.onerror = xhr.onabort = xhr.ontimeout = () => { cleanup(); reject(new Error('Upload unconfirmed')); };
    signal.addEventListener('abort', abort, { once: true });
    xhr.send(init?.body as XMLHttpRequestBodyInit | null | undefined);
  });
}

/** Never auto-replay an uncertain write. Marker contains no file bytes or filename and survives refresh and browser restarts. */
export async function uploadSafely(file: File, mediaType: string, scope: string, signal: AbortSignal,
  progress: (percent: number | null) => void, api: WorkspaceClient, storage: Storage = localStorage, visibility: FileVisibility = 'private'): Promise<UploadOutcome> {
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('');
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${file.name}\0${sha256}`))), b => b.toString(16).padStart(2, '0')).join('');
  const key = `tugpt-upload:${scope}:${visibility}:${fingerprint}`;
  const perform = async (): Promise<UploadOutcome> => {
    let pending: boolean;
    try { pending = storage.getItem(key) !== null; } catch { return { kind: 'unavailable' }; }
    let before: string | undefined; const seen = new Set<string>(); let exhausted = false;
    for (let page = 0; page < 50; page++) {
      if (signal.aborted) return { kind: 'uncertain' };
      const result = await api.listFiles({ scope: 'mine', limit: 100, before });
      if (!result.ok || !Array.isArray(result.value.files)) return { kind: 'unavailable' };
      const match = result.value.files.find(f => f.ownedByMe && f.visibility === visibility && f.filename === file.name && f.sizeBytes === file.size && f.sha256 === sha256);
      if (match) {
        if (match.status !== 'ready') return { kind: 'uncertain' };
        try { storage.removeItem(key); if (typeof window !== 'undefined') window.dispatchEvent(new Event('tugpt-upload-change')); } catch { /* A retained marker is conservative. */ }
        return { kind: 'existing', file: match };
      }
      if (!result.value.nextCursor) { exhausted = true; break; }
      if (seen.has(result.value.nextCursor)) return { kind: 'unavailable' };
      seen.add(result.value.nextCursor); before = result.value.nextCursor;
    }
    if (!exhausted) return { kind: 'unavailable' };
    if (pending || signal.aborted) return { kind: 'uncertain' };
    try { storage.setItem(key, 'pending'); if (typeof window !== 'undefined') window.dispatchEvent(new Event('tugpt-upload-change')); } catch { return { kind: 'unavailable' }; }
    const result = await createWorkspaceClient(uploadTransport(signal, progress)).uploadFile(file.slice(0, file.size, mediaType), file.name, visibility);
    if (result.ok && result.value.file?.status === 'ready') {
      try { storage.removeItem(key); if (typeof window !== 'undefined') window.dispatchEvent(new Event('tugpt-upload-change')); } catch { /* Safe to retain. */ }
      return { kind: 'stored', file: result.value.file };
    }
    // Only definitive rejections permit a fresh, explicit attempt.
    if (!result.ok && [400, 401, 403, 413, 415, 422, 429].includes(result.status)) {
      try { storage.removeItem(key); if (typeof window !== 'undefined') window.dispatchEvent(new Event('tugpt-upload-change')); } catch { return { kind: 'uncertain' }; }
      return { kind: 'failed' };
    }
    return { kind: 'uncertain' };
  };
  // Prevent simultaneous same-content uploads in this browser when Web Locks are available.
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(key, { ifAvailable: true }, lock => lock ? perform() : Promise.resolve({ kind: 'uncertain' as const }));
  return { kind: 'unavailable' };
}
