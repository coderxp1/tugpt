'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { BACKEND_GAPS, PROVIDER_NAME, START_PATH, usable, type ConnectProvider, type RouteState } from '@/lib/connect-ui/contract';
import { DisconnectDialog } from './DisconnectDialog';
import s from './connect.module.css';

export interface ProviderActionsProps {
  provider: ConnectProvider;
  state: 'connected' | 'requires_connection' | 'disabled_by_policy' | 'not_available';
  canManage: boolean;
  start: RouteState;
}

/** Connect / Use / Disconnect for one provider card. Only owners and admins get account actions. */
export function ProviderActions({ provider, state, canManage, start }: ProviderActionsProps) {
  const name = PROVIDER_NAME[provider];
  const [leaving, setLeaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setConfirming(false); trigger.current?.focus(); };

  if (state === 'connected') {
    return (
      <div className={s.actionsRow}>
        <Link className={s.primary} href="/dashboard/chat">Use in Chat</Link>
        {canManage && <button ref={trigger} type="button" className={s.secondary} onClick={() => setConfirming(true)}>Disconnect…</button>}
        {confirming && <DisconnectDialog providerName={name} gap={BACKEND_GAPS.B5} onClose={close} />}
      </div>
    );
  }
  if (state !== 'requires_connection') return null;
  if (!canManage) return <p className={s.muted}>Only an organization owner or admin can connect {name}.</p>;
  if (!usable(start)) {
    return (
      <div className={s.actionsRow}>
        <button type="button" className={s.primary} disabled aria-describedby={`${provider}-start-missing`}>Connect {name}</button>
        <p id={`${provider}-start-missing`} className={s.muted}>Connecting is not part of this build yet. It needs the Connect sign-in route <code>{START_PATH[provider]}</code>.</p>
      </div>
    );
  }
  return (
    <div className={s.actionsRow}>
      {/* A real navigation: the provider's consent page must load top-level. */}
      <a className={s.primary} href={START_PATH[provider]} aria-busy={leaving} onClick={() => setLeaving(true)}>
        {leaving ? `Opening ${name}…` : `Connect ${name}`}
      </a>
      <p className={s.muted}>You sign in on {name}&rsquo;s own page. TuGPT never sees your password.</p>
    </div>
  );
}
