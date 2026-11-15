import type { Metadata } from 'next';
import Link from 'next/link';
import { getSessionContext } from '@/lib/tenant/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { asChatDb, listCapabilities, type CapabilityRow, type CapabilityState } from '@/lib/chat/store';
import s from '@/components/connect/connect.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Connect · TuGPT' };

const STATE: Record<CapabilityState, { label: string; tone: string }> = {
  connected: { label: 'Connected', tone: s.ok },
  requires_connection: { label: 'Not connected', tone: s.idle },
  disabled_by_policy: { label: 'Turned off by your organization', tone: s.off },
  not_available: { label: 'Not available yet', tone: s.off },
};
const RANK: CapabilityState[] = ['connected', 'requires_connection', 'disabled_by_policy', 'not_available'];

const PROVIDER_COPY: Record<string, { blurb: string; next: Record<CapabilityState, string> }> = {
  google: {
    blurb: 'Calendar, Gmail and Drive for your Google Workspace account.',
    next: {
      connected: 'Type @ in Chat to use it.',
      requires_connection: 'Your Google account is not connected. Connecting from this page is not open yet; until it is, TuGPT has no access to your Google data.',
      disabled_by_policy: 'An administrator of your organization has turned this provider off.',
      not_available: 'Connecting Google accounts is not switched on for TuGPT yet. Nothing is connected, and TuGPT has no access to your Google data.',
    },
  },
  microsoft: {
    blurb: 'Outlook calendar, mail and OneDrive for your Microsoft 365 account.',
    next: {
      connected: 'Type @ in Chat to use it.',
      requires_connection: 'Your Microsoft 365 account is not connected. Connecting from this page is not open yet; until it is, TuGPT has no access to your Microsoft data.',
      disabled_by_policy: 'An administrator of your organization has turned this provider off.',
      not_available: 'Connecting Microsoft 365 accounts is not switched on for TuGPT yet. Nothing is connected, and TuGPT has no access to your Microsoft data.',
    },
  },
};

function group(rows: readonly CapabilityRow[]) {
  const by = new Map<string, CapabilityRow[]>();
  for (const r of rows) by.set(r.providerKey, [...(by.get(r.providerKey) ?? []), r]);
  return [...by.entries()].map(([key, caps]) => ({
    key, name: caps[0].providerName, caps,
    state: RANK.find((st) => caps.some((c) => c.state === st)) ?? 'not_available',
  }));
}

export default async function ConnectPage() {
  const session = await getSessionContext();
  let rows: CapabilityRow[] | null = null;
  if (session?.tenant) {
    try { rows = await listCapabilities(asChatDb(await createAuthenticatedServerClient()), session.tenant.organizationId); } catch { rows = null; }
  }
  const providers = rows ? group(rows) : [];
  return (
    <div className={s.page}>
      <header className={s.head}>
        <p className={s.eyebrow}>Connect</p>
        <h1>Your apps, in every chat</h1>
        <p>Connect an account once, then type <kbd>@</kbd> in Chat to let TuGPT use it for that message. Connections are personal unless your administrator shares one with the organization.</p>
      </header>
      {rows === null && <p className={s.error} role="alert">Connection status could not be loaded. Nothing is shown as connected until it can be checked.</p>}
      <ul className={s.grid}>
        {providers.map((p) => {
          const copy = PROVIDER_COPY[p.key];
          const st = STATE[p.state];
          return (
            <li key={p.key} className={s.card}>
              <div className={s.cardHead}>
                <span className={s.logo} aria-hidden="true">{p.name.charAt(0)}</span>
                <div><h2>{p.name}</h2>{copy && <p>{copy.blurb}</p>}</div>
                <span className={`${s.badge} ${st.tone}`}>{st.label}</span>
              </div>
              <h3 className={s.sub}>What TuGPT can do</h3>
              <ul className={s.caps}>
                {p.caps.map((c) => (
                  <li key={c.capabilityKey}>
                    <span>{c.description}</span>
                    <small>{c.permissionClass === 'read' ? 'Read only' : 'Can make changes · asks you first'}</small>
                  </li>
                ))}
              </ul>
              <p className={s.next}>{copy?.next[p.state] ?? ''}</p>
              {p.state === 'connected' && <Link className={s.primary} href="/dashboard/chat">Use in Chat</Link>}
            </li>
          );
        })}
      </ul>
      <p className={s.foot}>When connecting is available, you sign in on the provider&rsquo;s own page, so TuGPT never sees your password. Access is limited to the permissions listed on each card, and every use in Chat is recorded in your organization&rsquo;s audit log.</p>
    </div>
  );
}
