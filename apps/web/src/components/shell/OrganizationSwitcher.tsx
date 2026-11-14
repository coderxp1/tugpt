'use client';
import { useState } from 'react';
import type { TenantContext } from '@tugpt/auth';

export function OrganizationSwitcher({ label }: { label: string }) {
  const [organizations, setOrganizations] = useState<TenantContext[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function load() {
    setBusy(true); setError(false);
    try {
      const res = await fetch('/api/v1/organizations/active', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      setOrganizations((await res.json()).organizations);
    } catch { setError(true); } finally { setBusy(false); }
  }
  async function select(id: string) {
    if (!id) return;
    setBusy(true); setError(false);
    try {
      const res = await fetch('/api/v1/organizations/active', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tugpt-csrf': '1' }, body: JSON.stringify({ organizationId: id }) });
      if (!res.ok) throw new Error();
      // Full navigation discards every tenant-bound client cache and draft.
      window.location.reload();
    } catch { setError(true); setBusy(false); }
  }
  return <div className="flex items-center gap-2 text-sm">
    {organizations === null ? <button type="button" onClick={load} disabled={busy} className="rounded border border-zinc-300 px-2 py-1 disabled:opacity-50">{label}</button> :
      <select aria-label={label} defaultValue="" onChange={e => select(e.target.value)} disabled={busy} className="max-w-48 rounded border border-zinc-300 p-1">
        <option value="" disabled>{label}</option>
        {organizations.map(org => <option key={org.organizationId} value={org.organizationId}>{org.organizationName}</option>)}
      </select>}
    {error && <span role="alert">{label}: error</span>}
  </div>;
}
