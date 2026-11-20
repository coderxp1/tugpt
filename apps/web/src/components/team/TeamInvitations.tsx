'use client';

/**
 * Team invitations card for Dashboard → Settings.
 *
 * Uses the existing, tested invitation API only:
 *   GET  /api/v1/invitations                       list (owner/admin; RLS-scoped to the active org)
 *   POST /api/v1/invitations                       create { email, role } → one-time token
 *   POST /api/v1/invitations/:id/revoke            revoke a pending invitation
 *
 * TuGPT does not send invitation e-mail. The inviter receives a one-time link and shares it
 * themselves. The token is placed in the URL fragment (`/invite#<token>`) so it never reaches
 * server logs, proxies or Referer headers; it is shown once and never stored by this component.
 * Authorization is enforced by the database; the UI only hides controls the server would refuse.
 */
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import s from '@/components/connect/connect.module.css';
import { GENERIC_ERROR as GENERIC, readInvitationError } from '@/lib/team/invitation-errors';

export type Invitation = { id: string; email: string; role: string; status: string; expires_at: string; created_at: string };
type Created = { invitation_id: string; token: string; email: string; role: string; expires_at: string };

export const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Administrator', manager: 'Manager', agent: 'Member', viewer: 'Viewer' };
const STATUS_LABEL: Record<string, string> = { pending: 'Pending', accepted: 'Accepted', revoked: 'Revoked', expired: 'Expired' };
const JSON_HEADERS = { 'Content-Type': 'application/json', 'x-tugpt-csrf': '1' };

export function canManageInvitations(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/** Roles the current user may offer. Only owners may create other owners. */
export function invitableRoles(role: string | null | undefined): string[] {
  const base = ['viewer', 'agent', 'manager', 'admin'];
  return role === 'owner' ? [...base, 'owner'] : base;
}

export function inviteLink(origin: string, token: string): string {
  return `${origin}/invite#${encodeURIComponent(token)}`;
}

/** Pending invitations whose expiry has passed are shown as expired; the server sweeps them later. */
export function effectiveStatus(inv: Pick<Invitation, 'status' | 'expires_at'>, now = Date.now()): string {
  if (inv.status === 'pending' && Date.parse(inv.expires_at) <= now) return 'expired';
  return inv.status;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function errorText(res: Response): Promise<string> {
  return (await readInvitationError(res)).message;
}

type LoadResult = { items: Invitation[] } | { error: string };

async function fetchInvitations(): Promise<LoadResult> {
  try {
    const res = await fetch('/api/v1/invitations', { cache: 'no-store' });
    if (!res.ok) return { error: await errorText(res) };
    const body = (await res.json()) as { invitations?: Invitation[] };
    return { items: body.invitations ?? [] };
  } catch {
    return { error: 'Invitations could not be loaded. Check your connection and try again.' };
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function TeamInvitations({ role, organizationName }: { role: string | null; organizationName: string | null }) {
  const manage = canManageInvitations(role);
  const ids = { email: useId(), role: useId(), link: useId(), status: useId() };
  const [items, setItems] = useState<Invitation[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState('agent');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'manual'>('idle');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apply = useCallback((r: LoadResult) => {
    if ('items' in r) { setLoadError(null); setItems(r.items); } else { setLoadError(r.error); }
  }, []);
  const load = useCallback(async () => { apply(await fetchInvitations()); }, [apply]);

  // Same pattern as McpPanel: fetch purely, apply in .then, ignore results after unmount.
  useEffect(() => {
    if (!manage) return;
    let live = true;
    void fetchInvitations().then((r) => { if (live) apply(r); });
    return () => { live = false; };
  }, [manage, apply]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null); setNotice(null); setCreated(null); setCopied('idle');
    const value = email.trim();
    if (!EMAIL.test(value)) { setFormError('Enter a valid e-mail address.'); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/v1/invitations', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ email: value, role: newRole }) });
      if (!res.ok) { setFormError(await errorText(res)); return; }
      const body = (await res.json()) as { invitation: Created };
      setCreated(body.invitation);
      setEmail('');
      await load();
    } catch { setFormError(GENERIC); } finally { setBusy(false); }
  }

  async function copy(link: string) {
    try { await navigator.clipboard.writeText(link); setCopied('copied'); }
    catch { setCopied('manual'); (document.getElementById(ids.link) as HTMLInputElement | null)?.select(); }
  }

  async function revoke(inv: Invitation) {
    setRowError(null); setNotice(null); setBusy(true);
    try {
      const res = await fetch(`/api/v1/invitations/${encodeURIComponent(inv.id)}/revoke`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
      if (!res.ok) { setRowError(await errorText(res)); return; }
      setConfirmId(null);
      if (created?.invitation_id === inv.id) setCreated(null);
      setNotice(`Invitation for ${inv.email} was revoked. The link no longer works.`);
      await load();
    } catch { setRowError(GENERIC); } finally { setBusy(false); }
  }

  if (!manage) {
    return (
      <section className={s.card} aria-labelledby="team-h">
        <h2 id="team-h">Team</h2>
        <p className={s.next}>Owners and administrators of {organizationName ?? 'this organization'} can invite colleagues. Ask one of them to send you or your colleague an invitation link.</p>
      </section>
    );
  }

  const link = created && typeof window !== 'undefined' ? inviteLink(window.location.origin, created.token) : '';

  return (
    <section className={s.card} aria-labelledby="team-h" style={{ gridColumn: '1 / -1' }}>
      <h2 id="team-h">Team</h2>
      <p className={s.next}>Invite a colleague to {organizationName ?? 'this organization'}. TuGPT creates a one-time link; you send it to them yourself. They must sign in with the same e-mail address to join.</p>

      <form className={s.form} onSubmit={submit} noValidate aria-describedby={formError ? ids.status : undefined}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end' }}>
          <label htmlFor={ids.email} style={{ display: 'grid', gap: '0.25rem', flex: '1 1 16rem' }}>
            <span>E-mail address</span>
            <input id={ids.email} type="email" autoComplete="off" inputMode="email" maxLength={320} required value={email}
              onChange={(e) => setEmail(e.target.value)} aria-invalid={formError ? true : undefined}
              style={{ border: '1px solid #a1a1aa', borderRadius: 6, padding: '0.5rem 0.625rem', minHeight: 44 }} />
          </label>
          <label htmlFor={ids.role} style={{ display: 'grid', gap: '0.25rem', flex: '0 1 12rem' }}>
            <span>Role</span>
            <select id={ids.role} value={newRole} onChange={(e) => setNewRole(e.target.value)}
              style={{ border: '1px solid #a1a1aa', borderRadius: 6, padding: '0.5rem', minHeight: 44 }}>
              {invitableRoles(role).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
          <button type="submit" className={s.primary} disabled={busy} style={{ minHeight: 44 }}>{busy ? 'Working…' : 'Create invitation'}</button>
        </div>
        {formError && <p id={ids.status} role="alert" className={s.error}>{formError}</p>}
      </form>

      {created && (
        <div className={s.bannerOk} role="status" style={{ marginTop: '1rem' }}>
          <p><strong>Invitation created for {created.email}</strong> as {ROLE_LABEL[created.role] ?? created.role}. Valid until {formatDate(created.expires_at)}.</p>
          <p>Copy this link now and send it to them. For security it is shown only once.</p>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <label htmlFor={ids.link} className={s.sr}>Invitation link</label>
            <input id={ids.link} readOnly value={link} onFocus={(e) => e.currentTarget.select()}
              style={{ flex: '1 1 20rem', minWidth: 0, fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem', border: '1px solid #a1a1aa', borderRadius: 6, padding: '0.5rem', minHeight: 44 }} />
            <button type="button" className={s.secondary} onClick={() => copy(link)} style={{ minHeight: 44 }}>Copy link</button>
          </div>
          <p aria-live="polite">{copied === 'copied' ? 'Link copied.' : copied === 'manual' ? 'Copying is blocked by your browser. The link is selected; press Ctrl+C or ⌘C.' : ''}</p>
        </div>
      )}

      {notice && <p className={s.bannerOk} role="status" style={{ marginTop: '1rem' }}>{notice}</p>}

      <h3 style={{ marginTop: '1.5rem' }}>Invitations</h3>
      {loadError ? (
        <div role="alert" className={s.bannerError}><p>{loadError}</p><button type="button" className={s.secondary} onClick={() => { setLoadError(null); setItems(null); void load(); }}>Try again</button></div>
      ) : items === null ? (
        <p aria-busy="true">Loading invitations…</p>
      ) : items.length === 0 ? (
        <p className={s.muted}>No invitations yet. Invite your first colleague above.</p>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <caption className={s.sr}>Invitations for {organizationName ?? 'this organization'}</caption>
            <thead><tr><th scope="col">E-mail</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Expires</th><th scope="col"><span className={s.sr}>Actions</span></th></tr></thead>
            <tbody>
              {items.map((inv) => {
                const st = effectiveStatus(inv);
                return (
                  <tr key={inv.id}>
                    <td style={{ overflowWrap: 'anywhere' }}>{inv.email}</td>
                    <td>{ROLE_LABEL[inv.role] ?? inv.role}</td>
                    <td><span className={s.badge}>{STATUS_LABEL[st] ?? st}</span></td>
                    <td>{st === 'pending' ? formatDate(inv.expires_at) : '—'}</td>
                    <td>
                      {st === 'pending' && (confirmId === inv.id ? (
                        <span role="group" aria-label={`Confirm revoking the invitation for ${inv.email}`} style={{ display: 'inline-flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                          <button type="button" className={s.danger} disabled={busy} onClick={() => void revoke(inv)}>Revoke</button>
                          <button type="button" className={s.secondary} disabled={busy} onClick={() => { setConfirmId(null); setRowError(null); }}>Keep</button>
                        </span>
                      ) : (
                        <button type="button" className={s.secondary} disabled={busy} onClick={() => { setConfirmId(inv.id); setRowError(null); }} aria-label={`Revoke invitation for ${inv.email}`}>Revoke…</button>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rowError && <p role="alert" className={s.error}>{rowError}</p>}
    </section>
  );
}
