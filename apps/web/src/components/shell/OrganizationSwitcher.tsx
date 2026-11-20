'use client';
import { useState } from 'react';
import type { TenantContext } from '@tugpt/auth';

const ROLE: Record<string, string> = { owner: 'Owner', admin: 'Administrator', manager: 'Manager', agent: 'Member', viewer: 'Viewer' };

/**
 * Lists the caller's organizations only after an explicit click, marks the one
 * in use, and switches with a full reload so no tenant-bound state survives.
 */
export function OrganizationSwitcher({ label, currentId = null }: { label: string; currentId?: string | null }) {
  const [organizations, setOrganizations] = useState<TenantContext[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function load() {
    setBusy('load'); setError(null);
    try {
      const res = await fetch('/api/v1/organizations/active', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      setOrganizations((await res.json()).organizations);
    } catch { setError('Your organizations could not be loaded. Try again.'); } finally { setBusy(null); }
  }
  async function select(id: string) {
    if (!id || id === currentId) return;
    setBusy(id); setError(null);
    try {
      const res = await fetch('/api/v1/organizations/active', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tugpt-csrf': '1' }, body: JSON.stringify({ organizationId: id }) });
      if (!res.ok) throw new Error();
      // Full navigation discards every tenant-bound client cache and draft.
      window.location.reload();
    } catch { setError('Switching did not work. You are still in the same organization.'); setBusy(null); }
  }
  if (organizations === null) return <div>
    <button type="button" onClick={load} disabled={busy !== null} className="rounded border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50">{busy === 'load' ? 'Loading…' : label}</button>
    {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
  </div>;
  return <div>
    <ul aria-label="Your organizations" className="space-y-2">
      {organizations.map((org) => {
        const current = org.organizationId === currentId;
        return <li key={org.organizationId} className="flex flex-wrap items-center justify-between gap-2 rounded border border-zinc-200 px-3 py-2 text-sm">
          <span><strong>{org.organizationName}</strong> <span className="text-zinc-600">· {ROLE[org.role] ?? org.role}</span></span>
          {current
            ? <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold" aria-label={`${org.organizationName} is the organization you are using now`}>Current</span>
            : <button type="button" onClick={() => void select(org.organizationId)} disabled={busy !== null} className="rounded border border-zinc-300 px-3 py-1 disabled:opacity-50" aria-label={`Switch to ${org.organizationName}`}>{busy === org.organizationId ? 'Switching…' : 'Switch'}</button>}
        </li>;
      })}
    </ul>
    {organizations.length === 1 && <p className="mt-2 text-sm text-zinc-600">You belong to one organization.</p>}
    {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
  </div>;
}
