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
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { EmailText } from './EmailText';
import s from '@/components/connect/connect.module.css';
import { readInvitationError } from '@/lib/team/invitation-errors';
import { useT } from '@/i18n/provider';
import { formatDate as fmtDate } from '@/i18n';
import type { Translator } from '@/i18n/types';
import { canManageOrg, roleLabel } from '@/lib/team/roles';

export type Invitation = { id: string; email: string; role: string; status: string; expires_at: string; created_at: string };
type Created = { invitation_id: string; token: string; email: string; role: string; expires_at: string };

/** English role names, for callers without a translator. Prefer roleLabel(role, t). */
export const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Administrator', manager: 'Manager', agent: 'Member', viewer: 'Viewer' };
const STATUSES = new Set(['pending', 'accepted', 'revoked', 'expired']);
const JSON_HEADERS = { 'Content-Type': 'application/json', 'x-tugpt-csrf': '1' };

export function canManageInvitations(role: string | null | undefined): boolean {
  return canManageOrg(role);
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

async function errorText(res: Response, t: Translator): Promise<string> {
  return (await readInvitationError(res, t)).message;
}

type LoadResult = { items: Invitation[] } | { error: string };

async function fetchInvitations(t: Translator): Promise<LoadResult> {
  try {
    const res = await fetch('/api/v1/invitations', { cache: 'no-store' });
    if (!res.ok) return { error: await errorText(res, t) };
    const body = (await res.json()) as { invitations?: Invitation[] };
    return { items: body.invitations ?? [] };
  } catch {
    return { error: t('team.inv.loadFailed') };
  }
}


export function TeamInvitations({ role, organizationName }: { role: string | null; organizationName: string | null }) {
  const t = useT();
  const manage = canManageInvitations(role);
  const org = organizationName ?? t('team.thisOrg');
  const formatDate = (iso: string) => (Number.isNaN(Date.parse(iso)) ? '—' : fmtDate(iso, t.locale));
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
  // Focus moves to the outcome after an async action, so keyboard and screen-reader users never land on <body>.
  const createdRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (created) createdRef.current?.focus(); }, [created]);
  useEffect(() => { if (notice) noticeRef.current?.focus(); }, [notice]);

  const apply = useCallback((r: LoadResult) => {
    if ('items' in r) { setLoadError(null); setItems(r.items); } else { setLoadError(r.error); }
  }, []);
  const load = useCallback(async () => { apply(await fetchInvitations(t)); }, [apply, t]);

  // Same pattern as McpPanel: fetch purely, apply in .then, ignore results after unmount.
  useEffect(() => {
    if (!manage) return;
    let live = true;
    void fetchInvitations(t).then((r) => { if (live) apply(r); });
    return () => { live = false; };
  }, [manage, apply, t]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null); setNotice(null); setCreated(null); setCopied('idle');
    const value = email.trim();
    if (!EMAIL.test(value)) { setFormError(t('team.inv.invalidEmail')); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/v1/invitations', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ email: value, role: newRole }) });
      if (!res.ok) { setFormError(await errorText(res, t)); return; }
      const body = (await res.json()) as { invitation: Created };
      setCreated(body.invitation);
      setEmail('');
      await load();
    } catch { setFormError(t('team.err.generic')); } finally { setBusy(false); }
  }

  async function copy(link: string) {
    try { await navigator.clipboard.writeText(link); setCopied('copied'); }
    catch { setCopied('manual'); (document.getElementById(ids.link) as HTMLInputElement | null)?.select(); }
  }

  async function revoke(inv: Invitation) {
    setRowError(null); setNotice(null); setBusy(true);
    try {
      const res = await fetch(`/api/v1/invitations/${encodeURIComponent(inv.id)}/revoke`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
      if (!res.ok) { setRowError(await errorText(res, t)); return; }
      setConfirmId(null);
      if (created?.invitation_id === inv.id) setCreated(null);
      setNotice(t('team.inv.revoked', { email: inv.email }));
      await load();
    } catch { setRowError(t('team.err.generic')); } finally { setBusy(false); }
  }

  if (!manage) {
    return (
      <section className={s.card} aria-labelledby="team-h" id="team">
        <h2 id="team-h">{t('team.inv.titleMember')}</h2>
        <p className={s.next}>{t('team.inv.memberBody', { org })}</p>
      </section>
    );
  }

  const link = created && typeof window !== 'undefined' ? inviteLink(window.location.origin, created.token) : '';

  return (
    <section className={s.card} aria-labelledby="team-h" id="team">
      <h2 id="team-h">{t('team.inv.title')}</h2>
      <p className={s.next}>{t('team.inv.lead', { org })}</p>

      <form className={s.form} onSubmit={submit} noValidate aria-describedby={formError ? ids.status : undefined}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end' }}>
          <label htmlFor={ids.email} style={{ display: 'grid', gap: '0.25rem', flex: '1 1 16rem' }}>
            <span>{t('team.inv.email')}</span>
            <input id={ids.email} type="email" autoComplete="off" inputMode="email" maxLength={320} required value={email}
              onChange={(e) => setEmail(e.target.value)} aria-invalid={formError ? true : undefined}
              style={{ border: '1px solid #a1a1aa', borderRadius: 6, padding: '0.5rem 0.625rem', minHeight: 44 }} />
          </label>
          <label htmlFor={ids.role} style={{ display: 'grid', gap: '0.25rem', flex: '0 1 12rem' }}>
            <span>{t('team.inv.role')}</span>
            <select id={ids.role} value={newRole} onChange={(e) => setNewRole(e.target.value)}
              style={{ border: '1px solid #a1a1aa', borderRadius: 6, padding: '0.5rem', minHeight: 44 }}>
              {invitableRoles(role).map((r) => <option key={r} value={r}>{roleLabel(r, t)}</option>)}
            </select>
          </label>
          <button type="submit" className={s.primary} disabled={busy} style={{ minHeight: 44 }}>{busy ? t('team.inv.working') : t('team.inv.create')}</button>
        </div>
        {formError && <p id={ids.status} role="alert" className={s.error}>{formError}</p>}
      </form>

      {created && (
        <div className={s.bannerOk} role="status" ref={createdRef} tabIndex={-1} style={{ marginTop: '1rem' }}>
          <p><strong>{t('team.inv.created', { email: created.email, role: roleLabel(created.role, t), date: formatDate(created.expires_at) })}</strong></p>
          <p>{t('team.inv.copyNow')}</p>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <label htmlFor={ids.link} className={s.sr}>{t('team.inv.linkLabel')}</label>
            <input id={ids.link} readOnly value={link} onFocus={(e) => e.currentTarget.select()}
              style={{ flex: '1 1 20rem', minWidth: 0, fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem', border: '1px solid #a1a1aa', borderRadius: 6, padding: '0.5rem', minHeight: 44 }} />
            <button type="button" className={s.secondary} onClick={() => copy(link)} style={{ minHeight: 44 }}>{t('team.inv.copy')}</button>
          </div>
          <p aria-live="polite">{copied === 'copied' ? t('team.inv.copied') : copied === 'manual' ? t('team.inv.copyBlocked') : ''}</p>
        </div>
      )}

      {notice && <p className={s.bannerOk} role="status" ref={noticeRef} tabIndex={-1} style={{ marginTop: '1rem' }}>{notice}</p>}

      <h3 style={{ marginTop: '1.5rem' }}>{t('team.inv.sent')}</h3>
      {loadError ? (
        <div role="alert" className={s.bannerError}><p>{loadError}</p><button type="button" className={s.secondary} onClick={() => { setLoadError(null); setItems(null); void load(); }}>{t('team.inv.retry')}</button></div>
      ) : items === null ? (
        <p aria-busy="true">{t('team.inv.loading')}</p>
      ) : items.length === 0 ? (
        <p className={s.muted}>{t('team.inv.empty')}</p>
      ) : (
        <div className={s.tableWrap}>
          <table className={`${s.table} ${s.stack}`}>
            <caption className={s.sr}>{t('team.inv.caption', { org })}</caption>
            <thead><tr><th scope="col">{t('team.col.email')}</th><th scope="col">{t('team.col.role')}</th><th scope="col">{t('team.col.status')}</th><th scope="col">{t('team.col.expires')}</th><th scope="col">{t('team.col.action')}</th></tr></thead>
            <tbody>
              {items.map((inv) => {
                const st = effectiveStatus(inv);
                return (
                  <tr key={inv.id}>
                    <td data-label={t('team.col.email')}><EmailText value={inv.email} /></td>
                    <td data-label={t('team.col.role')}>{roleLabel(inv.role, t)}</td>
                    <td data-label={t('team.col.status')}><span className={`${s.badge} ${st === 'pending' ? s.idle : s.off}`}>{STATUSES.has(st) ? t(`team.inv.status.${st as 'pending'}`) : st}</span></td>
                    <td data-label={t('team.col.expires')} className={s.nowrap}>{st === 'pending' ? formatDate(inv.expires_at) : '—'}</td>
                    <td data-label={t('team.col.action')}>
                      {st === 'pending' && (confirmId === inv.id ? (
                        <span role="group" aria-label={t('team.inv.confirmFor', { email: inv.email })} style={{ display: 'inline-flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                          <button type="button" className={s.danger} disabled={busy} onClick={() => void revoke(inv)}>{t('team.inv.revoke')}</button>
                          <button type="button" className={s.secondary} disabled={busy} onClick={() => { setConfirmId(null); setRowError(null); }}>{t('team.inv.keep')}</button>
                        </span>
                      ) : (
                        <button type="button" className={s.secondary} disabled={busy} onClick={() => { setConfirmId(inv.id); setRowError(null); }} aria-label={t('team.inv.revokeFor', { email: inv.email })}>{t('team.inv.revokeAsk')}</button>
                      ))}
                      {st !== 'pending' && <span className={s.muted}>{t('team.inv.noAction')}</span>}
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
