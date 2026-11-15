'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { PROVIDER_NAME, START_PATH, usable, type ConnectProvider, type RouteState } from '@/lib/connect-ui/contract';
import { DISCONNECT_TEXT, disconnectProvider } from '@/lib/connect-ui/disconnect';
import { DisconnectDialog } from './DisconnectDialog';
import s from './connect.module.css';

export interface ProviderActionsProps {
  provider: ConnectProvider;
  state: 'connected' | 'requires_connection' | 'disabled_by_policy' | 'not_available';
  canManage: boolean;
  start: RouteState;
  /** Availability of POST /api/v1/connect/{provider}/disconnect on this build. */
  disconnect: RouteState;
  /** Injectable for tests. */
  disconnectFetch?: typeof fetch;
}

/** Connect / Use / Disconnect for one provider card. Only owners and admins get account actions. */
export function ProviderActions({ provider, state, canManage, start, disconnect, disconnectFetch }: ProviderActionsProps) {
  const name = PROVIDER_NAME[provider];
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setConfirming(false); trigger.current?.focus(); };

  /** Status shown afterwards always comes from a fresh server read, never from this result alone. */
  async function runDisconnect(): Promise<string | null> {
    const outcome = await disconnectProvider(provider, disconnectFetch);
    if (outcome === 'revoked') {
      router.replace(`/dashboard/connect?${provider}=revoked`);
      router.refresh();
      return null;
    }
    router.refresh();
    return DISCONNECT_TEXT[outcome](name);
  }

  if (state === 'connected') {
    return (
      <div className={s.actionsRow}>
        <Link className={s.primary} href="/dashboard/chat">Use in Chat</Link>
        {canManage && <button ref={trigger} type="button" className={s.secondary} onClick={() => setConfirming(true)}>Disconnect…</button>}
        {confirming && (
          <DisconnectDialog
            providerName={name}
            onConfirm={usable(disconnect) ? runDisconnect : undefined}
            onClose={close}
            onDone={() => setConfirming(false)}
          />
        )}
      </div>
    );
  }
  if (state !== 'requires_connection') return null;
  if (!canManage) return <p className={s.muted}>Only an organization owner or admin can connect {name}.</p>;
  if (!usable(start)) {
    return (
      <div className={s.actionsRow}>
        <button type="button" className={s.primary} disabled aria-describedby={`${provider}-start-missing`}>Connect {name}</button>
        <p id={`${provider}-start-missing`} className={s.muted}>Connecting is not part of this build. It needs the Connect sign-in route <code>{START_PATH[provider]}</code>.</p>
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
