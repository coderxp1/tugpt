'use client';
import { useState } from 'react';
import type { TenantContext } from '@tugpt/auth';
import { useT } from '@/i18n/provider';
import { roleLabel } from '@/lib/team/roles';

/**
 * Lists the caller's organizations only after an explicit click, marks the one
 * in use, and switches with a full reload so no tenant-bound state survives.
 */
export function OrganizationSwitcher({ label, currentId = null }: { label: string; currentId?: string | null }) {
  const t = useT();
  const [organizations, setOrganizations] = useState<TenantContext[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function load() {
    setBusy('load'); setError(null);
    try {
      const res = await fetch('/api/v1/organizations/active', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      setOrganizations((await res.json()).organizations);
    } catch { setError(t('org.loadFailed')); } finally { setBusy(null); }
  }
  async function select(id: string) {
    if (!id || id === currentId) return;
    setBusy(id); setError(null);
    try {
      const res = await fetch('/api/v1/organizations/active', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tugpt-csrf': '1' }, body: JSON.stringify({ organizationId: id }) });
      if (!res.ok) throw new Error();
      // Full navigation discards every tenant-bound client cache and draft.
      window.location.reload();
    } catch { setError(t('org.switchFailed')); setBusy(null); }
  }
  if (organizations === null) return <div>
    <button type="button" onClick={load} disabled={busy !== null} className="rounded border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50">{busy === 'load' ? t('org.loading') : label}</button>
    {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
  </div>;
  return <div>
    <ul aria-label={t('org.list')} className="space-y-2">
      {organizations.map((org) => {
        const current = org.organizationId === currentId;
        return <li key={org.organizationId} className="flex flex-wrap items-center justify-between gap-2 rounded border border-zinc-200 px-3 py-2 text-sm">
          <span><strong>{org.organizationName}</strong> <span className="text-zinc-600">· {roleLabel(org.role, t)}</span></span>
          {current
            ? <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold" aria-label={t('org.currentAria', { org: org.organizationName })}>{t('org.current')}</span>
            : <button type="button" onClick={() => void select(org.organizationId)} disabled={busy !== null} className="rounded border border-zinc-300 px-3 py-1 disabled:opacity-50" aria-label={t('org.switchTo', { org: org.organizationName })}>{busy === org.organizationId ? t('org.switching') : t('org.switch')}</button>}
        </li>;
      })}
    </ul>
    {organizations.length === 1 && <p className="mt-2 text-sm text-zinc-600">{t('org.one')}</p>}
    {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
  </div>;
}
