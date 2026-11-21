'use client';
import { useSyncExternalStore } from 'react';
import { useT } from '@/i18n/provider';
function subscribe(notify: () => void) {
  window.addEventListener('storage', notify);
  window.addEventListener('tugpt-upload-change', notify);
  return () => { window.removeEventListener('storage', notify); window.removeEventListener('tugpt-upload-change', notify); };
}
export function PendingUploads({ scope }: { scope?: string }) {
  const t = useT();
  const count = useSyncExternalStore(subscribe, () => {
    if (!scope) return 0;
    try { let n = 0; for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith(`tugpt-upload:${scope}:`)) n++; } return n; } catch { return -1; }
  }, () => 0);
  if (!count) return null;
  return <p role="status">{count < 0
    ? (t.locale === 'es' ? 'No se puede comprobar la recuperación de subidas: el almacenamiento del navegador no está disponible.' : 'Upload recovery cannot be checked: browser storage is unavailable.')
    : (t.locale === 'es' ? `${count} intentos de subida siguen sin confirmar en este navegador. Seleccione los archivos originales para comprobar las copias guardadas. No se reenviarán automáticamente.` : `${count} upload attempts are still unconfirmed in this browser. Reselect the original files to check saved copies. Nothing will be uploaded again automatically.`)}</p>;
}
