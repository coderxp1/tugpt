'use client';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/provider';
import u from './ui.module.css';
/** Workspace-only preference: never changes organization settings or Dashboard locale. */
export function WorkspaceLanguage() {
  const t = useT();
  const router = useRouter();
  return <label className={u.field}>{t.locale === 'es' ? 'Idioma del espacio de trabajo' : 'Workspace language'}
    <select value={t.locale} onChange={event => {
      const locale = event.target.value === 'es' ? 'es' : 'en';
      document.cookie = `tugpt_workspace_locale=${locale}; Path=/workspace; Max-Age=31536000; SameSite=Lax; Secure`;
      router.refresh();
    }}><option value="en">English</option><option value="es">Español</option></select>
  </label>;
}
