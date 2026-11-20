'use client';

/**
 * Invitee side of a team invitation: /invite#<token>.
 *
 * The token arrives in the URL fragment (never sent to the server by the browser). On load it is
 * moved into sessionStorage (this tab only) and removed from the address bar and history, so it
 * survives a sign-in round trip but is not left in the URL, bookmarks or screenshots. Joining is an
 * explicit click; nothing is accepted automatically. The database enforces that the signed-in
 * account's verified e-mail matches the invitation and that the invitation is still pending.
 */
import { useState } from 'react';
import Link from 'next/link';
import s from '@/components/connect/connect.module.css';
import { readInvitationError } from '@/lib/team/invitation-errors';
import { roleLabel } from '@/lib/team/roles';
import { useT } from '@/i18n/provider';

export const PENDING_INVITE_KEY = 'tugpt.pendingInvite';
const JSON_HEADERS = { 'Content-Type': 'application/json', 'x-tugpt-csrf': '1' };
const TERMINAL = new Set(['INVITATION_NOT_FOUND', 'INVITATION_NOT_PENDING', 'INVITATION_EXPIRED']);

/** Reads the token from the fragment (preferred) or this tab's storage, then scrubs the URL. */
export function takeInviteToken(win: Pick<Window, 'location' | 'history' | 'sessionStorage'>): string | null {
  const raw = win.location.hash.replace(/^#/, '');
  let token: string | null = null;
  if (raw) {
    try { token = decodeURIComponent(raw).trim() || null; } catch { token = null; }
    win.history.replaceState(null, '', win.location.pathname + win.location.search);
    if (token && token.length <= 512) { try { win.sessionStorage.setItem(PENDING_INVITE_KEY, token); } catch { /* storage blocked */ } }
    else token = null;
  }
  if (!token) { try { token = win.sessionStorage.getItem(PENDING_INVITE_KEY); } catch { token = null; } }
  return token;
}

type State =
  | { kind: 'none' } | { kind: 'ready' } | { kind: 'busy' }
  | { kind: 'joined'; organizationId: string; role: string; created: boolean }
  | { kind: 'error'; code: string | null; status: number; message: string };

export function InviteAccept() {
  const t = useT();
  // Browser-only component (loaded with ssr:false by InviteAcceptClient), so window exists on first render.
  const [token] = useState<string | null>(() => takeInviteToken(window));
  const [state, setState] = useState<State>(() => (token ? { kind: 'ready' } : { kind: 'none' }));
  const [opening, setOpening] = useState(false);

  function forget() { try { window.sessionStorage.removeItem(PENDING_INVITE_KEY); } catch { /* ignore */ } }

  async function join() {
    if (!token) return;
    setState({ kind: 'busy' });
    try {
      const res = await fetch('/api/v1/invitations/accept', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token }) });
      if (!res.ok) {
        const err = await readInvitationError(res, t);
        if (err.code && TERMINAL.has(err.code)) forget();
        setState({ kind: 'error', ...err });
        return;
      }
      const body = (await res.json()) as { membership: { organization_id: string; role: string; membership_created: boolean } };
      forget();
      setState({ kind: 'joined', organizationId: body.membership.organization_id, role: body.membership.role, created: body.membership.membership_created });
    } catch {
      setState({ kind: 'error', code: null, status: 0, message: t('team.err.generic') });
    }
  }

  async function openOrganization(organizationId: string) {
    setOpening(true);
    try {
      const res = await fetch('/api/v1/organizations/active', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ organizationId }) });
      if (!res.ok) throw new Error('switch failed');
      window.location.assign('/dashboard/settings');
    } catch {
      setOpening(false);
      setState({ kind: 'error', code: 'SWITCH_FAILED', status: 0, message: t('invite.switchFailed') });
    }
  }

  return (
    <div className={s.page}>
      <header className={s.head}><p className={s.eyebrow}>{t('invite.eyebrow')}</p><h1>{t('invite.title')}</h1></header>
      <section className={s.card} aria-labelledby="invite-h" aria-live="polite" style={{ maxWidth: '40rem' }}>
        <h2 id="invite-h">
          {state.kind === 'joined' ? t('invite.h.joined') : state.kind === 'none' ? t('invite.h.none') : t('invite.h.invited')}
        </h2>

        {state.kind === 'none' && (
          <p className={s.next}>{t('invite.none.body')}</p>
        )}

        {(state.kind === 'ready' || state.kind === 'busy') && (
          <>
            <p className={s.next}>{t('invite.ready.body')}</p>
            <div className={s.actions}>
              <button type="button" className={s.primary} onClick={() => void join()} disabled={state.kind === 'busy'} style={{ minHeight: 44 }}>
                {state.kind === 'busy' ? t('invite.joining') : t('invite.join')}
              </button>
              <Link className={s.secondary} href="/dashboard" onClick={forget}>{t('invite.notNow')}</Link>
            </div>
          </>
        )}

        {state.kind === 'joined' && (
          <>
            <p className={s.next}>
              {t(state.created ? 'invite.joined' : 'invite.already', { role: roleLabel(state.role, t) })}
            </p>
            <div className={s.actions}>
              <button type="button" className={s.primary} disabled={opening} onClick={() => void openOrganization(state.organizationId)} style={{ minHeight: 44 }}>
                {opening ? t('invite.opening') : t('invite.open')}
              </button>
            </div>
          </>
        )}

        {state.kind === 'error' && (
          <div role="alert" className={s.bannerError}>
            <p>{state.message}</p>
            {state.code === 'VERIFIED_EMAIL_REQUIRED' && (
              <p>{t('invite.verifyHelp')}</p>
            )}
            <div className={s.actions}>
              {(state.status === 401 || state.code === 'VERIFIED_EMAIL_REQUIRED' || state.code === 'INVITATION_WRONG_ACCOUNT') && (
                <Link className={s.secondary} href="/auth/logout" prefetch={false}>{t('invite.signOutIn')}</Link>
              )}
              {token && !(state.code && TERMINAL.has(state.code)) && state.code !== 'SWITCH_FAILED' && (
                <button type="button" className={s.secondary} onClick={() => void join()}>{t('invite.tryAgain')}</button>
              )}
              <Link className={s.secondary} href="/dashboard">{t('invite.toDashboard')}</Link>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
